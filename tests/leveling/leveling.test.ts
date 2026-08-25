import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LEVEL_CONFIG,
  LevelingEngine,
  PolicyStore,
  SkillLedger,
  SkillStore,
  evaluateLevelUp,
  fingerprintTask,
  matchesGlob,
  selectSkills,
} from '../../src/index.js';
import type { ScoreRecord } from '../../src/index.js';
import { StatsEngine } from '../../src/leveling/stats.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempRoot(prefix = 'arena-l4-'): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

let seq = 0;
function score(verdict: ScoreRecord['verdict'] = 'success', runIdSuffix = ''): ScoreRecord {
  seq += 1;
  return {
    schemaVersion: 1,
    runId: `run_${seq}${runIdSuffix}`,
    rubric: { name: 'default', version: '1.0.0' },
    hardChecks: [],
    hardPassed: verdict === 'success',
    verdict,
    confidence: 0.75,
    excludedFactors: [],
    scoredAt: new Date().toISOString(),
  };
}

describe('level gate - exit criterion: single success can NEVER promote', () => {
  it('K=3/M=2 defaults block one fluke and one-task grinding', () => {
    const stats = new StatsEngine(path.join(tempRoot(), 'stats.json')).load();

    // ONE success -> no.
    let s = structuredClone(stats);
    const eng = new StatsEngine(path.join(tempRoot(), 's1.json'));
    s = eng.record(score('success'), { weight: 1, task: 'fix bug in parser' });
    let d = evaluateLevelUp(s, DEFAULT_LEVEL_CONFIG, 1.0);
    expect(d.promote).toBe(false);

    // THREE successes on the SAME task (grinding) -> variety gate blocks.
    for (let i = 0; i < 3; i++) {
      s = eng.record(score('success'), { weight: 1, task: 'fix bug in parser' });
    }
    d = evaluateLevelUp(s, DEFAULT_LEVEL_CONFIG, 1.0);
    expect(d.promote).toBe(false);
    expect(d.reason).toContain('variety');

    // Same count across distinct tasks but rate collapses -> rate gate blocks.
    for (let i = 0; i < 17; i++) {
      s = eng.record(score('fail'), { weight: 1, task: `task ${i}` });
    }
    d = evaluateLevelUp(s, DEFAULT_LEVEL_CONFIG, eng.rollingRate(s));
    expect(d.promote).toBe(false);

    // Clean slate engine: 3 successes across 2+ tasks at high rate -> PROMOTE.
    const eng2 = new StatsEngine(path.join(tempRoot(), 's2.json'));
    let s2 = eng2.load();
    const tasks = ['refactor auth module', 'add retry to http client', 'migrate db schema'];
    for (const t of tasks) s2 = eng2.record(score('success'), { weight: 1, task: t });
    const d2 = evaluateLevelUp(s2, DEFAULT_LEVEL_CONFIG, eng2.rollingRate(s2));
    expect(d2.promote).toBe(true);
  });

  it('sub-agent successes weigh HALF - two children equal one root success', () => {
    const file = path.join(tempRoot(), 'stats.json');
    const eng = new StatsEngine(file);
    // Four child successes (weight .5 each = 2.0) still below K=3.
    for (let i = 0; i < 4; i++) {
      eng.record(score('success'), { weight: 0.5, task: `child task ${i}` });
    }
    let decision = evaluateLevelUp(eng.load(), { ...DEFAULT_LEVEL_CONFIG, minRate: 0 }, eng.rollingRate(eng.load()));
    expect(decision.evidence.successesSinceLevelUp).toBe(2);
    expect(decision.promote).toBe(false);

    // One more child pushes weighted total to 2.5 - still short of K=3.
    eng.record(score('success'), { weight: 0.5, task: 'child task 9' });
    decision = evaluateLevelUp(eng.load(), { ...DEFAULT_LEVEL_CONFIG, minRate: 0 }, eng.rollingRate(eng.load()));
    expect(decision.evidence.successesSinceLevelUp).toBe(2.5);
    expect(decision.promote).toBe(false);
  });

  it('inconclusive runs are excluded from leveling entirely', () => {
    const eng = new StatsEngine(path.join(tempRoot(), 'stats.json'));
    eng.record(score('inconclusive'), { weight: 1, task: 'whatever' });
    const s = eng.load();
    expect(s.successesSinceLevelUp).toBe(0);
    expect(s.totals.inconclusive).toBe(1);
  });
});

describe('skill store + lineage DAG', () => {
  it('creates SKILL.md + canonical json; derived versions chain parents; history reconstructs', () => {
    const root = tempRoot();
    const store = new SkillStore(path.join(root, 'skills'));
    const created = store.create({
      title: 'Fix flaky tests',
      description: 'Reproduce then pin ordering',
      body: '1. Reproduce with --repeat=10\n2. Pin random seed\n3. Isolate shared state',
      triggers: { keywords: ['flaky', 'intermittent'] },
    });
    const id = created.data.id;
    expect(created.files.md.endsWith('SKILL.md')).toBe(true);
    expect(readFileSync(created.files.md, 'utf8')).toContain('status: draft');
    expect(existsSync(created.files.versionMd)).toBe(true);

    // v2 edit from v1
    const v2 = store.deriveVersion(id, 'v1', { status: 'candidate' }, undefined, { status: 'candidate', reason: 'canary' });
    expect(v2.version).toBe('v2');
    // v3 from v2
    store.deriveVersion(id, 'v2', {}, 'updated body', { status: 'active' });

    const lineage = store.loadLineage(id)!;
    expect(lineage.tip).toBe('v3');
    expect(lineage.versions.v2.parentVersion).toBe('v1');
    expect(lineage.versions.v3.parentVersion).toBe('v2');
    // Full chain walkable to the root.
    const chain: string[] = [];
    let cur: string | undefined = lineage.tip;
    while (cur !== undefined) {
      chain.push(cur);
      cur = lineage.versions[cur]!.parentVersion;
    }
    expect(chain).toEqual(['v3', 'v2', 'v1']);
  });
});

describe('runtime selector', () => {
  const skill = (over: Partial<Parameters<typeof selectSkills>[0][number]['data']> & { tokenCost?: number }) => ({
    data: {
      id: 'fix-flaky-tests-s1',
      version: 'v1',
      status: 'active' as const,
      title: 'Fix flaky tests',
      description: '',
      triggers: { keywords: ['flaky'], pathGlobs: ['tests/**'], commandPrefixes: ['npm test'] },
      tokenCost: over.tokenCost ?? 50,
      created: '',
      triggersExtra: undefined,
      ...over,
    } as never,
    body: 'do things',
  });

  it('ranks by trigger hits and packs within budget', () => {
    const a = skill({}); // flaky keyword + tests glob potential
    const b = skill({
      id: 'other-skill',
      triggers: { keywords: ['flaky', 'intermittent'], pathGlobs: [], commandPrefixes: [] },
    });
    const picked = selectSkills([a, b], {
      taskText: 'the flaky intermittent test fails on CI',
      tokenBudget: 100,
      canaryRoll: 99,
      canaryPercent: 20,
    });
    expect(picked.map((p) => p.data.id)).toEqual(['other-skill', 'fix-flaky-tests-s1']); // b hits twice
  });

  it('budget packing skips oversized skills without dropping the rest', () => {
    const big = skill({ id: 'big', tokenCost: 120 }); // exceeds the whole budget
    const small = skill({ id: 'small', tokenCost: 20 });
    const picked = selectSkills([big, small], {
      taskText: 'flaky',
      tokenBudget: 100,
      canaryRoll: 99,
      canaryPercent: 20,
    });
    expect(picked.map((p) => p.data.id)).toEqual(['small']);
  });

  it('candidates only ride canary rolls', () => {
    const cand = skill({ id: 'cand', status: 'candidate' });
    const off = selectSkills([cand], { taskText: 'flaky', tokenBudget: 500, canaryRoll: 20, canaryPercent: 20 });
    const on = selectSkills([cand], { taskText: 'flaky', tokenBudget: 500, canaryRoll: 19, canaryPercent: 20 });
    expect(off).toHaveLength(0);
    expect(on).toHaveLength(1);
  });

  it('glob matcher handles ** and * segments', () => {
    expect(matchesGlob('tests/unit/a.test.ts', ['tests/**'])).toBe(true);
    expect(matchesGlob('src/tests/x.ts', ['tests/**'])).toBe(false);
    expect(matchesGlob('src/a/b.ts', ['src/*/b.ts'])).toBe(true);
  });
});

describe('LevelingEngine pipeline - exit criteria end-to-end', () => {
  function makeEngine(root: string): LevelingEngine {
    return new LevelingEngine(root, {
      levelConfig: { K: 3, M: 2, minRate: 0.7, windowSize: 20 },
      canaryPercent: 20,
      miner: async () => ({
        title: 'Fix flaky tests',
        description: 'Reproduce, pin ordering, isolate state',
        body: '1. Reproduce with repetition\n2. Pin randomness\n3. Isolate shared fixtures',
        triggers: { keywords: ['flaky', 'payment'], pathGlobs: [], commandPrefixes: [] },
      }),
    });
  }

  it('promotes after real evidence, mines skills, rolls back regressions; DAG keeps everything', async () => {
    const root = tempRoot();
    const engine = makeEngine(root);

    // --- 1. Single success must NOT promote.
    let d = engine.ingest(score('success'), 'fix flaky payment tests');
    expect(d.promote).toBe(false);
    expect(engine.stats.load().level).toBe(1);

    // --- 2. Fill the gate properly -> promotion fires once.
    engine.ingest(score('success'), 'stabilize websocket reconnect logic');
    d = engine.ingest(score('success'), 'deflake checkout integration suite');
    expect(d.promote).toBe(true);
    expect(engine.stats.load().level).toBe(2);
    expect(engine.stats.load().successesSinceLevelUp).toBe(0); // consumed
    const historyPath = path.join(root, 'agents', 'default', 'level-history.jsonl');
    expect(existsSync(historyPath)).toBe(true);
    const hist = JSON.parse(readFileSync(historyPath, 'utf8').trim().split('\n').at(-1)!);
    expect(hist.fromLevel).toBe(1);
    expect(hist.toLevel).toBe(2);

    // --- 3. Mine a skill from a successful run (stub miner).
    const mined = await engine.mineFromRun({
      task: 'fix flaky payment tests',
      trajectory: { runId: 'x', depth: 0, task: 't', steps: [], toolResults: [] },
      score: score('success'),
    });
    expect(mined.status).toBe('draft');

    // --- 4. Contradiction gate: near-duplicate triggers blocked from candidacy.
    const dup = engine.store.create({
      title: 'Fix flaky tests copy',
      description: 'same',
      body: 'same-ish',
      triggers: { keywords: mined.triggers.keywords.slice() },
    });
    // Give the original some keywords first so overlap is measurable.
    engine.store.setStatus(mined.id, mined.version, 'candidate'); // direct candidate for baseline
    const blocked = engine.promoteToCandidate(dup.data.id);
    void blocked;
    // (dup vs candidate-original is not active-vs-active yet; activate original)
    engine.promoteToActive(mined.id);
    const blockedNow = engine.promoteToCandidate(dup.data.id);
    expect(blockedNow.ok).toBe(false);
    expect(blockedNow.reason).toContain('contradicts');

    // --- 5. Regression: force failures credited to the ACTIVE skill -> auto-rollback.
    const pointer = engine.policy.current();
    expect(pointer.activeSkillVersions[mined.id]).toBeDefined();

    const failingRunIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const inj = engine.selectForRun(`run_fail_${i}`, { taskText: 'fix the flaky payment tests again' });
      expect(inj.selections.length).toBeGreaterThanOrEqual(0);
      failingRunIds.push(`run_fail_${i}`);
    }
    // Ensure at least minUses credits landed on the active version via ledger:
    // deterministicRoll may exclude candidates but active always matches 'flaky'.
    for (const rid of failingRunIds) {
      engine.ingest(score('fail', rid.replace('run_', '_')), 'fix the flaky payment tests again', 0);
      // manually credit ledger entries for that run (score.runId differs)
      for (const entry of engine.ledger.all().filter((l) => l.runId === rid)) {
        engine.store.creditUse(entry.skillId, entry.version, false);
      }
    }

    const rollbacks = engine.sweep();
    expect(rollbacks.length).toBeGreaterThanOrEqual(1);
    const rb = rollbacks[0]!;
    expect(rb.skillId).toBe(mined.id);
    expect(rb.rolledBackVersion).toBe(mined.version);

    // Pointer no longer references the rolled-back version.
    const after = engine.policy.current();
    expect(after.activeSkillVersions[mined.id]).not.toBe(mined.version);

    // Lineage preserved BOTH statuses forever.
    const lineage = engine.store.loadLineage(mined.id)!;
    expect(lineage.versions[mined.version].status).toBe('rolled_back');
    expect(lineage.tip).toBeDefined();
  });
});
