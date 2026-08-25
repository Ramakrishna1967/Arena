import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentExecutor,
  ArenaOrchestrator,
  PermissionManager,
  createProvider,
  defineBundle,
  starterBundle,
} from '../../src/index.js';
import type { PolicyBundle } from '../../src/index.js';
import type { AgentEvent } from '../../src/index.js';
import { ScriptedProvider, type ScriptedTurn } from '../agent/fake-provider.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'arena-orch-'));
  dirs.push(d);
  return d;
}

function makeOrch(turns: ScriptedTurn[], opts?: { maxDepth?: number }) {
  const adapter = createProvider('openai', { apiKey: 'test', fetchImpl: async () => { throw new Error('no network in tests'); } });
  void adapter;
  // Orchestrator needs an adapter; reuse ScriptedProvider directly as the adapter.
  const provider = new ScriptedProvider(turns);
  const perms = new PermissionManager({ default: 'allow', rules: [] });
  const orch = new ArenaOrchestrator(provider, registry(), perms, opts);
  return { provider, orch };
}

// Minimal registry mirroring defaultRegistry (network-safe)
import { ToolRegistry, shellTool, readFileTool, writeFileTool, editFileTool, listDirTool, codeEvalTool } from '../../src/index.js';
import { webFetchTool, taskCompleteTool } from '../../src/index.js';
function registry(): ToolRegistry {
  return new ToolRegistry()
    .register(shellTool)
    .register(readFileTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(listDirTool)
    .register(webFetchTool)
    .register(codeEvalTool)
    .register(taskCompleteTool);
}

const spawnTurn = (label: string): ScriptedTurn => ({
  calls: [{ id: `spawn_${label}`, name: 'spawn_agent', arguments: { task: `recurse ${label}`, label } }],
});
const stopTurn = (text: string): ScriptedTurn => ({ text, finish: 'stop' });

describe('orchestrator - exit criteria', () => {
  it('recursive self-spawn terminates exactly at the hard depth cap', async () => {
    const ws = await workspace();
    const MAX_DEPTH = 2;
    // Depth-first consumption: root spawn, child spawn, leaf denial-stop,
    // then unwinding stops at each level.
    const turns: ScriptedTurn[] = [
      spawnTurn('a'),
      spawnTurn('b'),
      stopTurn('leaf done'),
      stopTurn('mid done'),
      stopTurn('root done'),
      stopTurn('never needed'),
    ];
    const { orch, provider } = makeOrch(turns, { maxDepth: MAX_DEPTH });

    const events: AgentEvent[] = [];
    const bundle = starterBundle({
      provider: 'openai',
      model: 'gpt-4o',
      budgets: { maxSteps: 32, maxToolCalls: 64, maxDepth: MAX_DEPTH },
    });
    const result = await orch.run('recurse as deep as allowed', bundle, { cwd: ws, onEvent: (e) => events.push(e) });

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('root done');

    // Tree shape: depths 0..MAX_DEPTH present, nothing deeper, linked parents.
    const starts = events.filter((e): e is Extract<AgentEvent, { type: 'run_start' }> => e.type === 'run_start');
    expect(starts.map((s) => s.depth).sort()).toEqual([0, 1, 2]);
    const byDepth = new Map(starts.map((s) => [s.depth, s]));
    const root = byDepth.get(0)!;
    const mid = byDepth.get(1)!;
    const leaf = byDepth.get(2)!;
    expect(mid.parentId).toBe(root.runId);
    expect(leaf.parentId).toBe(mid.runId);

    // At the cap the gate removes the spawn tool entirely - the leaf literally
    // cannot fan out further (schema surface, not just runtime denial).
    const leafRequestTools = (provider.requests[2]!.tools ?? []).map((t) => t.name);
    expect(leafRequestTools).not.toContain('spawn_agent');

    // Exactly two successful spawns happened (root->mid, mid->leaf).
    const spawns = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result',
    );
    expect(spawns.map((s) => s.ok)).toEqual([true, true]);
    expect(result.steps).toBe(2);
  }, 20000);

  it('budget-exhausted subtree dies gracefully and reports upward', async () => {
    const ws = await workspace();
    const burn = (): ScriptedTurn => ({
      calls: [{ id: `ld_${Math.random().toString(36).slice(2, 6)}`, name: 'list_dir', arguments: { path: '.' } }],
    });
    const { orch, provider } = makeOrch([
      spawnTurn('burner'),
      // Child script: burns its derived budget of 2 tool calls...
      burn(),
      burn(),
      burn(), // never reached - exhaustion hits first
      // ...parent observes failure and wraps up.
      stopTurn(`aborting plan`),
    ]);

    const events: AgentEvent[] = [];
    const bundle = starterBundle({
      provider: 'openai',
      model: 'm',
      budgets: { maxSteps: 8, maxToolCalls: 8 }, // child derives floor(7*0.5)=3 steps / 3 tools
    });
    const result = await orch.run('delegate burning work', bundle, { cwd: ws, onEvent: (e) => events.push(e) });

    // Parent completed normally after the child's graceful death.
    expect(result.status).toBe('completed');

    const childEnd = events.find(
      (e): e is Extract<AgentEvent, { type: 'run_end' }> => e.type === 'run_end' && e.depth === 1,
    );
    expect(childEnd?.status).toBe('budget_exhausted');

    // The spawn tool_result fed to the parent model says so explicitly.
    const req = provider.requests.at(-1)!;
    const spawnResultMsg = req.messages.find((m) => m.role === 'tool' && m.name === 'spawn_agent');
    expect(spawnResultMsg?.isError).toBe(true);
    expect(spawnResultMsg?.text).toContain('status=budget_exhausted');
  }, 20000);

  it('child trajectories are fully attributable (ids, parents, depths)', async () => {
    const ws = await workspace();
    const { orch } = makeOrch([
      spawnTurn('worker'),
      stopTurn('ok'), // child
      stopTurn('done'), // root
    ]);
    const events: AgentEvent[] = [];
    await orch.run('main', starterBundle({ provider: 'xai', model: 'grok-3', budgets: { maxSteps: 6, maxToolCalls: 6, maxDepth: 1 } }), {
      cwd: ws,
      onEvent: (e) => events.push(e),
    });

    // EVERY event carries meta; run ids form a closed set.
    for (const e of events) {
      expect(typeof e.runId).toBe('string');
      expect(e.depth).toBeGreaterThanOrEqual(0);
    }
    const runIds = new Set(events.map((e) => e.runId));
    const childStart = events.find((e) => e.type === 'run_start' && e.depth === 1)!;
    expect(runIds.has(childStart.parentId!)).toBe(true);
    // Every child run_end pairs with its own run_start.
    const ends = events.filter((e): e is Extract<AgentEvent, { type: 'run_end' }> => e.type === 'run_end');
    for (const end of ends) expect(runIds.has(end.runId)).toBe(true);
  }, 20000);

  it('narrowed allowlists: child cannot touch tools outside its manifest', async () => {
    const ws = await workspace();
    const { orch, provider } = makeOrch([
      {
        calls: [
          {
            id: 'spawn_r',
            name: 'spawn_agent',
            arguments: { task: 'narrow work', label: 'restricted', tools: ['write_file', 'read_file'] },
          },
        ],
      },
      // child attempts a tool it did not request
      { calls: [{ id: 'c1', name: 'run_command', arguments: { command: 'node -e "console.log(1)"' } }] },
      { calls: [{ id: 'c2', name: 'task_complete', arguments: { summary: 'did what I could' } }] },
      stopTurn('wrapped'), // root
    ]);
    const events: AgentEvent[] = [];
    await orch.run('delegate narrowly', starterBundle({ provider: 'openai', model: 'm', budgets: { maxSteps: 8, maxToolCalls: 8, maxDepth: 1 } }), {
      cwd: ws,
      onEvent: (e) => events.push(e),
    });

    const childReq = provider.requests[1]!;
    // Child schema surface excludes everything except its narrowed set.
    const offered = (childReq.tools ?? []).map((t) => t.name).sort();
    expect(offered).toEqual(['read_file', 'task_complete', 'write_file']);

    const deniedCall = events.find(
      (e): e is Extract<AgentEvent, { type: 'tool_call' }> => e.type === 'tool_call' && e.call.name === 'run_command',
    );
    expect(deniedCall?.permitted).toBe(false);
  }, 20000);
});

describe('spawn gate unit behavior', () => {
  it('depth 0 cap removes spawn tool entirely from schema surface', async () => {
    const ws = await workspace();
    const { orch, provider } = makeOrch([{ calls: [{ id: 'c', name: 'task_complete', arguments: { summary: 'solo' } }] }]);
    const base = starterBundle({ provider: 'openai', model: 'm' });
    const bundle = defineBundle({
      ...base,
      budgets: { maxSteps: 2, maxToolCalls: 2, maxDepth: 0 },
    });
    const r = await orch.run('no delegation', bundle, { cwd: ws });
    expect(r.status).toBe('completed');
    const offered = (provider.requests[0]!.tools ?? []).map((t) => t.name);
    expect(offered).not.toContain('spawn_agent');
  });

  it('AgentExecutor remains directly usable below the orchestrator (L2 boundary intact)', () => {
    expect(AgentExecutor).toBeDefined();
  });
});
