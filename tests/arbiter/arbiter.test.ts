import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentExecutor,
  Arbiter,
  DEFAULT_RUBRIC_NAME,
  PermissionManager,
  Recorder,
  ToolRegistry,
  loadEvents,
  listDirTool,
  starterBundle,
  taskCompleteTool,
  writeFileTool,
} from '../../src/index.js';
import type { AgentEvent, JudgeFn } from '../../src/index.js';
import { ProviderError } from '../../src/providers/errors.js';
import { ScriptedProvider, type ScriptedTurn } from '../agent/fake-provider.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempRoot(prefix = 'arena-l3-'): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const generousJudge: JudgeFn = async ({ dimensions }) => ({
  dimensions: Object.fromEntries(dimensions.map((d) => [d.id, { score: d.id === 'efficiency' ? 9 : 7, rationale: 'stub' }])),
  overallComment: 'stubbed',
  usage: { inputTokens: 120, outputTokens: 60 },
});

function smallRegistry(): ToolRegistry {
  return new ToolRegistry().register(writeFileTool).register(listDirTool).register(taskCompleteTool);
}

/** Runs a scripted single-agent scenario into a recorded run directory. */
async function recordScenario(turns: ScriptedTurn[], opts: { permissionDefault?: 'allow' | 'deny'; provider?: ScriptedProvider } = {}): Promise<string> {
  const ws = await tempRoot('arena-ws-');
  const provider = opts.provider ?? new ScriptedProvider(turns);
  const executor = new AgentExecutor(
    provider,
    smallRegistry(),
    new PermissionManager({ default: opts.permissionDefault ?? 'allow', rules: [] }),
  );
  const runDir = await tempRoot('arena-run-');
  const rec = new Recorder(runDir);
  await executor.run(
    'create notes/todo.txt saying hello',
    starterBundle({ provider: 'openai', model: 'gpt-4o', budgets: { maxSteps: 4, maxToolCalls: 8 } }),
    { cwd: ws, onEvent: rec.sink() },
  );
  rec.finalize();
  return runDir;
}

describe('recorder', () => {
  it('writes self-contained JSONL that replays identically; meta finalized', async () => {
    const runDir = await recordScenario([
      { calls: [{ id: 'c1', name: 'write_file', arguments: { path: 'notes/todo.txt', content: 'hello' } }] },
      { text: 'Done writing.', finish: 'stop' },
    ]);

    const events = loadEvents(runDir);
    expect(events[0]).toMatchObject({ type: 'run_start', task: 'create notes/todo.txt saying hello' });
    const tr = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
    expect(tr?.output).toContain('wrote');

    // Replay from disk equals what was written (JSONL alone suffices).
    expect(loadEvents(runDir)).toEqual(events);

    const meta = JSON.parse(readFileSync(path.join(runDir, 'meta.json'), 'utf8'));
    expect(meta.rootRunId).toBe(events[0].runId);
    expect(meta.status).toBe('completed');
    expect(typeof meta.startedAt).toBe('string');
  });

  it('throws a line-numbered error on corrupted logs', async () => {
    const runDir = await tempRoot();
    writeFileSync(path.join(runDir, 'events.jsonl'), '{"type":"text"}\nNOT JSON AT ALL\n');
    expect(() => loadEvents(runDir)).toThrowError(/line 2/);
  });
});

describe('arbiter - exit criteria', () => {
  it('two-stage scoring: success story with pinned rubric + exact weighted math', async () => {
    const runDir = await recordScenario([
      { calls: [{ id: 'c1', name: 'write_file', arguments: { path: 'notes/todo.txt', content: 'hello' } }] },
      { text: 'Created the file.', finish: 'stop' },
    ]);
    const arbiter = new Arbiter({ arenaRoot: await tempRoot(), judge: generousJudge });

    const record = await arbiter.scoreRun(runDir);

    // Rubric version pinned verbatim.
    expect(record.rubric).toEqual({ name: DEFAULT_RUBRIC_NAME, version: '1.0.0' });
    // Hard checks ran first, versioned.
    expect(record.hardChecks.map((c) => c.check)).toEqual(['run_completed', 'tolerable_tool_failures']);
    expect(record.hardChecks.every((c) => c.checkVersion >= 1)).toBe(true);
    expect(record.hardPassed).toBe(true);

    // Stub scores 7,7,9,7 -> .45*.7 + .25*.7 + .15*.9 + .15*.7 = 0.73
    expect(record.judge?.weightedOverall).toBeCloseTo(0.73, 5);
    expect(record.verdict).toBe('success');
    expect(record.judgeUsage).toEqual({ inputTokens: 120, outputTokens: 60 });

    // Persisted next to the evidence.
    const file = path.join(runDir, 'scores', `${record.rubric.name}.${record.runId}.json`);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(record);
  });

  it('identical run re-scores deterministically (hard stage pure; fixed clock)', async () => {
    const runDir = await recordScenario([
      { calls: [{ id: 'c1', name: 'write_file', arguments: { path: 'f.txt', content: 'x' } }] },
      { text: 'done', finish: 'stop' },
    ]);
    const arbiter = new Arbiter({ arenaRoot: await tempRoot(), judge: generousJudge });
    const now = (): Date => new Date(1234567890);

    const a = await arbiter.scoreRun(runDir, { now, persist: false });
    const b = await arbiter.scoreRun(runDir, { now, persist: false });
    expect(b).toEqual(a);
  });

  it('hard fail is decisive: judge never consulted, verdict fail at high confidence', async () => {
    let judgeCalled = 0;
    const spyJudge: JudgeFn = async (req) => {
      judgeCalled += 1;
      return generousJudge(req);
    };
    const runDir = await recordScenario([{ text: 'plain answer', finish: 'stop' }]);
    const events = loadEvents(runDir);
    const rootRunId = events[0]!.runId;

    // Rewrite the tail as an aborted/budget-exhausted run.
    const aborted = [
      ...events.filter((e) => !(e.runId === rootRunId && e.type === 'run_end')),
      { type: 'run_end', status: 'budget_exhausted', errorMessage: 'maxSteps reached', runId: rootRunId, depth: 0 } as unknown as AgentEvent,
    ];

    const arbiter = new Arbiter({ arenaRoot: await tempRoot(), judge: spyJudge });
    const record = await arbiter.scoreRun(aborted, { persist: false });
    expect(judgeCalled).toBe(0);
    expect(record.hardPassed).toBe(false);
    expect(record.verdict).toBe('fail');
    expect(record.confidence).toBe(0.99);
    expect(record.judge).toBeUndefined();
    expect(record.excludedFactors).toEqual([]);
  });

  it('provider-attributable failures score inconclusive and are excluded from agent stats', async () => {
    const flaky = new ScriptedProvider([]);
    flaky.complete = (async function* () {
      throw new ProviderError('transport_retryable', 'upstream failure (500): oops', { provider: 'openai' });
      yield {} as never; // unreachable
    }) as typeof flaky.complete;
    const runDir = await recordScenario([], { provider: flaky });

    const arbiter = new Arbiter({ arenaRoot: await tempRoot(), judge: generousJudge });
    const record = await arbiter.scoreRun(runDir, { persist: false });
    expect(record.verdict).toBe('inconclusive');
    expect(record.confidence).toBe(0.95);
    expect(record.excludedFactors).toEqual(['provider_fault:transport_retryable']);
  });

  it('judge lane failure degrades gracefully to hard-only success with exclusion note', async () => {
    const boomJudge: JudgeFn = async () => {
      throw new Error('judge lane down');
    };
    const runDir = await recordScenario([
      { calls: [{ id: 'c1', name: 'write_file', arguments: { path: 'f.txt', content: 'x' } }] },
      { text: 'done', finish: 'stop' },
    ]);
    const arbiter = new Arbiter({ arenaRoot: await tempRoot(), judge: boomJudge });
    const record = await arbiter.scoreRun(runDir, { persist: false });
    expect(record.verdict).toBe('success'); // hard-pass fallback
    expect(record.confidence).toBe(0.35);
    expect(record.judge).toBeUndefined();
    expect(record.excludedFactors[0]).toContain('judge_error:');
  });
});

describe('rubric engine', () => {
  function writeRubric(arenaRoot: string, rubric: unknown): void {
    mkdirSync(path.join(arenaRoot, 'rubrics'), { recursive: true });
    writeFileSync(path.join(arenaRoot, 'rubrics', `${(rubric as { name: string }).name}.json`), JSON.stringify(rubric));
  }

  it('custom rubric loads and its version pins; unknown check name rejected; bad weights rejected', async () => {
    const arenaRoot = await tempRoot();
    writeRubric(arenaRoot, {
      name: 'strict',
      version: '2.0.0',
      description: 'single-dimension',
      dimensions: [{ id: 'only', description: 'the thing', weight: 1 }],
      hardChecks: ['run_completed'],
    });

    const runDir = await recordScenario([
      { calls: [{ id: 'c1', name: 'write_file', arguments: { path: 'f.txt', content: 'x' } }] },
      { text: 'done', finish: 'stop' },
    ]);
    const arbiter = new Arbiter({ arenaRoot, judge: generousJudge });
    const record = await arbiter.scoreRun(runDir, { rubricName: 'strict', persist: false });
    expect(record.rubric.version).toBe('2.0.0');
    expect(record.judge?.weightedOverall).toBeCloseTo(0.7, 5); // single dim scored 7

    // Unknown check name -> explicit config error, not silent pass.
    writeRubric(arenaRoot, {
      name: 'broken-check',
      version: '1',
      dimensions: [{ id: 'only', description: '', weight: 1 }],
      hardChecks: ['does_not_exist'],
    });
    await expect(
      new Arbiter({ arenaRoot }).scoreRun(runDir, { rubricName: 'broken-check', persist: false }),
    ).rejects.toThrow(/unknown hard check/);

    // Weights must sum to ~1.
    writeRubric(arenaRoot, {
      name: 'bad',
      version: '1',
      dimensions: [
        { id: 'a', description: 'a', weight: 1 },
        { id: 'b', description: 'b', weight: 1 },
      ],
      hardChecks: [],
    });
    await expect(
      new Arbiter({ arenaRoot }).scoreRun(runDir, { rubricName: 'bad', persist: false }),
    ).rejects.toThrow(/weights sum/);

    // Unknown rubric name.
    await expect(new Arbiter({ arenaRoot }).scoreRun(runDir, { rubricName: 'nope', persist: false })).rejects.toThrow(/not found/);
  });
});
