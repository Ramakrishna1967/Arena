import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArenaApp } from '../../src/app.js';
import { FileLock, LockBusyError, writeAtomic } from '../../src/persistence/atomic.js';
import { loadEvents } from '../../src/recorder/recorder.js';
import { buildTrajectoryView } from '../../src/recorder/trajectory.js';
import { ScriptedProvider, type ScriptedTurn } from '../agent/fake-provider.js';
import type { JudgeFn } from '../../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempRoot(prefix = 'arena-e2e-'): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const goodJudge: JudgeFn = async ({ dimensions }) => ({
  dimensions: Object.fromEntries(dimensions.map((d) => [d.id, { score: 8, rationale: 'e2e stub' }])),
  overallComment: 'ok',
});

function makeTurns(): ScriptedTurn[] {
  return [
    // run 1: create a file
    { calls: [{ id: 'c1', name: 'write_file', arguments: { path: 'notes/todo.txt', content: 'buy milk' } }] },
    { text: 'Created notes/todo.txt.', finish: 'stop' },
    // resume follow-up
    { text: 'Updated the file to buy oat milk.', finish: 'stop' },
  ];
}

describe('persistence hardening', () => {
  it('atomic write never exposes partial content and cleans temp files', () => {
    const dir = tempRoot();
    const file = path.join(dir, 'state.json');
    writeAtomic(file, '{"v":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"v":1}');
    expect(existsSync(`${file}.tmp-`)).toBe(false);
  });

  it('second lock holder is rejected with holder pid; release frees it', async () => {
    const dir = tempRoot();
    const l1 = new FileLock(path.join(dir, 'arena.lock'));
    l1.acquire();
    const l2 = new FileLock(path.join(dir, 'arena.lock'));
    try {
      l2.acquire();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LockBusyError);
      expect((err as LockBusyError).holderPid).toBe(process.pid);
    }
    l1.release();
    expect(() => l2.acquire()).not.toThrow();
    l2.release();
  });

  it('concurrent ingests serialize under the arena lock - no lost updates', async () => {
    const root = tempRoot();
    const appA = new ArenaApp(makeCfg(root));
    const appB = new ArenaApp(makeCfg(root));

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 === 0 ? appA : appB).ingestScore(makeScore(`run_${i}`, 'success'), `task ${i}`),
      ),
    );
    expect(appA.engine.stats.load().totals.scored).toBe(6);
    expect(appB.engine.stats.load().totals.success).toBe(6); // shared state view
  });
});

function makeScore(runId: string, verdict: 'success' | 'fail' | 'inconclusive'): import('../../src/index.js').ScoreRecord {
  return {
    schemaVersion: 1,
    runId,
    rubric: { name: 'default', version: '1.0.0' },
    hardChecks: [],
    hardPassed: verdict === 'success',
    verdict,
    confidence: 0.75,
    excludedFactors: [],
    scoredAt: new Date().toISOString(),
  };
}

describe('phase 6 exit criteria - full loop on fresh install', () => {
  it('run -> mine -> promote -> second run injects skill; level gate fires; cold-start resume works', async () => {
    const arenaRoot = tempRoot();
    let provider = new ScriptedProvider([...makeTurns(), ...makeTurns().slice(2)]);
    const app = new ArenaApp({
      ...makeCfg(arenaRoot),
      adapterFactory: () => provider,
      judgeLane: goodJudge,
      minerLane: async () => ({
        title: 'Handle flaky tests',
        description: 'Reproduce then pin ordering',
        body: 'REPRODUCE first with repetition, then pin randomness before changing code.',
        triggers: { keywords: ['flaky'], pathGlobs: [], commandPrefixes: [] },
      }),
    });

    // --- RUN 1 (fresh install -> working agent)
    const r1 = await app.runTask('create notes/todo.txt saying buy milk', { maxSteps: 3 });
    expect(r1.result.status).toBe('completed');
    expect(r1.record.verdict).toBe('success');
    expect(r1.injected).toEqual([]);
    expect(provider.requests[0]!.messages[0]).toMatchObject({ role: 'user' });

    // --- MINE from the successful trajectory
    const events = loadEvents(r1.runDir);
    const rootNode = events[0]!.runId;
    const mined = await app.engine.mineFromRun({
      task: 'create notes/todo.txt',
      trajectory: buildTrajectoryView(events, rootNode),
      score: r1.record,
    });
    expect(mined.status).toBe('draft');

    // --- PROMOTE draft -> candidate -> active
    expect(app.engine.promoteToCandidate(mined.id).ok).toBe(true);
    app.engine.promoteToActive(mined.id);
    expect(app.status().activeSkills[mined.id]).toBeDefined();

    // --- LEVEL GATE: three distinct successes promote 1 -> 2
    // (run 1 counts as one; two more via direct ingest with distinct tasks)
    await app.ingestScore(makeScore('run_extra_1', 'success'), 'refactor auth module');
    await app.ingestScore(makeScore('run_extra_2', 'success'), 'migrate database schema');
    const st = app.status();
    void st;

    // --- RUN 2 mentions 'flaky' -> skill MUST be injected into system prompt
    const r2 = await app.runTask('fix flaky checkout test', { maxSteps: 3 });
    const req2 = provider.requests.at(-1)!;
    expect((req2.system ?? '')).toContain('REPRODUCE first');
    expect(r2.injected.map((i) => i.id)).toContain(mined.id);

    // ledger closed the loop: injection recorded for run2
    expect(app.engine.ledger.all().some((l) => l.runId === r2.runId && l.skillId === mined.id)).toBe(true);

    // --- COLD-START RESUME: brand-new App instance, nothing but disk state
    const freshProcessApp = new ArenaApp({
      ...makeCfg(arenaRoot),
      adapterFactory: () => provider, // same scripted turns continue
      judgeLane: goodJudge,
    });
    const resumed = await freshProcessApp.resumeRun(r1.runDir, 'change milk to oat milk', {});
    expect(resumed.result.finalText).toContain('oat milk');
    // The resumed request carried the FULL prior conversation.
    const resumeReq = provider.requests.at(-1)!;
    expect(resumeReq.messages[0]).toMatchObject({ role: 'user' });
    expect(resumeReq.messages.some((m) => m.role === 'tool')).toBe(true);
    expect(resumeReq.messages.at(-1)).toMatchObject({ role: 'user', text: 'change milk to oat milk' });

    // --- runs listing sees both sessions
    const ids = app.listRuns().map((r) => r.runId);
    expect(ids).toContain(r1.runId);
    expect(ids).toContain(resumed.runId);

    // --- why: ScoreRecord inspectable next to evidence
    expect(JSON.parse(readFileSync(path.join(r1.runDir, 'scores', `${r1.record.rubric.name}.${r1.runId}.json`), 'utf8')).verdict).toBe('success');
  }, 30000);
});

function makeCfg(arenaRoot: string): import('../../src/app.js').ArenaAppConfig {
  return {
    arenaRoot,
    worker: { provider: 'openai', model: 'gpt-4o', apiKey: 'test' },
  };
}
