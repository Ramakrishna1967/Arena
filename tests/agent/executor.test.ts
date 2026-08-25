import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentExecutor,
  PermissionManager,
  defaultRegistry,
  defineBundle,
  starterBundle,
} from '../../src/index.js';
import type { AgentEvent, RunResult } from '../../src/index.js';
import { ScriptedProvider, type ScriptedTurn } from './fake-provider.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'arena-exec-'));
  dirs.push(d);
  return d;
}

function harness(turns: ScriptedTurn[], opts: { defaultPermission?: 'allow' | 'deny' } = {}) {
  const provider = new ScriptedProvider(turns);
  const registry = defaultRegistry();
  const perms = new PermissionManager({ default: opts.defaultPermission ?? 'allow', rules: [] });
  const executor = new AgentExecutor(provider, registry, perms);
  const events: AgentEvent[] = [];
  return { provider, registry, executor, events };
}

async function runIn(ws: string, exec: AgentExecutor, turns: number, events: AgentEvent[]): Promise<RunResult> {
  const bundle = starterBundle({
    provider: 'openai',
    model: 'gpt-4o',
    system: 'You are Arena.',
    budgets: { maxSteps: turns, maxToolCalls: 16 },
  });
  return exec.run('do the thing', bundle, { cwd: ws, onEvent: (e) => events.push(e) });
}

describe('agent executor - exit criteria', () => {
  it('completes a multi-step file+shell task end-to-end; model observes real tool results', async () => {
    const ws = await workspace();
    const { executor, provider, events } = harness([
      {
        text: 'Creating the file.',
        calls: [{ id: 'c1', name: 'write_file', arguments: { path: 'notes/hello.txt', content: 'arena was here' } }],
      },
      {
        text: 'Verifying with shell.',
        calls: [{ id: 'c2', name: 'run_command', arguments: { command: `node -e "console.log(require('fs').readFileSync('notes/hello.txt','utf8').length)"` } }],
      },
      { text: 'All done.', finish: 'stop' },
    ]);

    const result = await runIn(ws, executor, 8, events);

    // Real filesystem effect
    expect(await readFile(path.join(ws, 'notes', 'hello.txt'), 'utf8')).toBe('arena was here');
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('All done.');
    expect(result.steps).toBe(3);

    // The model's second request MUST contain assistant toolCalls + a real tool result
    const req2 = provider.requests[1]!;
    const toolMsg = req2.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ role: 'tool', toolCallId: 'c1', isError: false });
    expect(toolMsg!.text).toContain('bytes to');

    // Event stream shape for renderers/recorders
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run_start');
    expect(types.filter((t) => t === 'step_start')).toHaveLength(3);
    expect(types.filter((t) => t === 'tool_call')).toHaveLength(2);
    expect(types.filter((t) => t === 'tool_result')).toHaveLength(2);
    expect(types.at(-1)).toBe('run_end');
  }, 20000);

  it('permission gate blocks unapproved commands; agent sees denial and adapts', async () => {
    const ws = await workspace();
    const marker = path.join(ws, 'should-not-exist.txt');
    const { executor, provider, events } = harness(
      [
        {
          calls: [{ id: 'c1', name: 'run_command', arguments: { command: `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}','x')"` } }],
        },
        { text: 'Understood, skipping that approach.', finish: 'stop' },
      ],
      { defaultPermission: 'deny' },
    );

    const bundle = starterBundle({
      provider: 'openai',
      model: 'gpt-4o',
      budgets: { maxSteps: 4, maxToolCalls: 8 },
    });
    const result = await executor.run('try to write marker', bundle, { cwd: ws, onEvent: (e) => events.push(e) });

    // Command never executed
    await expect(readFile(marker)).rejects.toThrow();

    const deniedToolMsg = provider.requests[1]!.messages.find((m) => m.role === 'tool');
    expect(deniedToolMsg?.isError).toBe(true);
    expect(deniedToolMsg?.text).toContain('PERMISSION DENIED');

    const deniedCall = events.find((e): e is Extract<AgentEvent, { type: 'tool_call' }> => e.type === 'tool_call');
    expect(deniedCall?.permitted).toBe(false);
    expect(result.status).toBe('completed');
  }, 20000);

  it('abort mid-run stops promptly with clean Ctrl-C semantics', async () => {
    const ws = await workspace();
    const controller = new AbortController();
    const { executor } = harness([{ hangUntilAbort: true }]);
    const bundle = starterBundle({ provider: 'openai', model: 'm', budgets: { maxSteps: 4, maxToolCalls: 8 } });

    const runPromise = executor.run('hang', bundle, { cwd: ws, signal: controller.signal });
    setTimeout(() => controller.abort(new DOMException('aborted by user', 'AbortError')), 50);

    const t0 = Date.now();
    const result = await runPromise;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(result.status).toBe('aborted');
    expect(result.errorMessage).toContain('user');
  }, 10000);

  it('step budget exhaustion returns explicit status', async () => {
    const ws = await workspace();
    const loopTurn = (): ScriptedTurn => ({
      calls: [{ id: `c${Math.random()}`, name: 'list_dir', arguments: { path: '.' } }],
    });
    const { executor } = harness([loopTurn(), loopTurn()]);
    const bundle = starterBundle({ provider: 'openai', model: 'm', budgets: { maxSteps: 2, maxToolCalls: 99 } });
    const result = await executor.run('loop forever', bundle, { cwd: ws });
    expect(result.status).toBe('budget_exhausted');
    expect(result.steps).toBe(2);
  }, 20000);

  it('task_complete tool terminates the run with its summary', async () => {
    const ws = await workspace();
    const { executor } = harness([
      { calls: [{ id: 'c1', name: 'task_complete', arguments: { summary: 'shipped it' } }] },
    ]);
    const bundle = starterBundle({ provider: 'openai', model: 'm', budgets: { maxSteps: 5, maxToolCalls: 9 } });
    const result = await executor.run('finish early', bundle, { cwd: ws });
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('shipped it');
  });

  it('unknown tools are denied without crashing the loop', async () => {
    const ws = await workspace();
    const { executor, provider } = harness([
      { calls: [{ id: 'c1', name: 'definitely_not_registered', arguments: {} }] },
      { text: 'ok moving on', finish: 'stop' },
    ]);
    const bundle = starterBundle({ provider: 'openai', model: 'm', budgets: { maxSteps: 3, maxToolCalls: 5 } });
    const result = await executor.run('use magic', bundle, { cwd: ws });
    expect(result.status).toBe('completed');
    const msg = provider.requests[1]!.messages.find((m) => m.role === 'tool');
    expect(msg?.isError).toBe(true);
    expect(msg?.text).toContain('not available');
  });
});

describe('policy bundle immutability', () => {
  it('defineBundle deep-freezes; bound snapshots cannot drift', () => {
    const b = defineBundle({
      id: 'g1',
      version: '1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      toolAllowlist: ['read_file'],
      permissions: { default: 'allow', rules: [] },
      budgets: { maxSteps: 2, maxToolCalls: 2 },
    });
    expect(Object.isFrozen(b));
    expect(Object.isFrozen(b.permissions));
    expect(Object.isFrozen(b.budgets));
    expect(() => {
      'use strict';
      (b as any).model = 'hacked';
    }).toThrow();
    expect(starterBundle({ provider: 'xai', model: 'grok-3' }).id).toBe('gen-local-0');
  });
});
