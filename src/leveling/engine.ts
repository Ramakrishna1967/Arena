import { appendFileSync } from 'node:fs';
import path from 'node:path';
import type { ScoreRecord } from '../arbiter/types.js';
import type { TrajectoryView } from '../recorder/trajectory.js';
import { ensureArenaRoot, agentDir, skillsDir, policyDir, weightForDepth } from './paths.js';
import { StatsEngine } from './stats.js';
import { evaluateLevelUp, type LevelDecision } from './gates.js';
import { SkillStore } from './skill-store.js';
import { PolicyStore, SkillLedger } from './policy.js';
import { selectSkills, type SelectedSkill, type SelectionInput } from './selector.js';
import type { MinerFn } from './miner.js';
import { findContradiction, regressionSweep, DEFAULT_REGRESSION, type RegressionOptions, type RollbackEvent } from './promotion.js';
import { DEFAULT_LEVEL_CONFIG, type LevelConfig, type SkillData } from './types.js';

export interface LevelingOptions {
  profile?: string;
  levelConfig?: LevelConfig;
  /** Token budget for skill injection (default 600). */
  skillTokenBudget?: number;
  canaryPercent?: number;
  miner?: MinerFn;
  regression?: RegressionOptions;
}

export interface SkillInjection {
  selections: SelectedSkill[];
  runId: string;
}

/**
 * L4 facade: the ONLY component that mutates leveling state. Consumes
 * ScoreRecords (+ tasks), owns gates, skill lifecycle, policy pointer,
 * ledger joins and rollback sweeps. Never talks to providers directly -
 * mining goes through the injected MinerFn on the meta lane.
 */
export class LevelingEngine {
  readonly stats: StatsEngine;
  readonly store: SkillStore;
  readonly policy: PolicyStore;
  readonly ledger: SkillLedger;
  private readonly cfg: LevelConfig;
  private readonly profile: string;
  private readonly opts: Required<Omit<LevelingOptions, 'levelConfig' | 'profile' | 'miner' | 'regression'>> & {
    miner?: MinerFn;
    regression: RegressionOptions;
  };

  constructor(
    readonly arenaRoot: string,
    opts: LevelingOptions = {},
  ) {
    ensureArenaRoot(arenaRoot);
    this.profile = opts.profile ?? 'default';
    this.cfg = opts.levelConfig ?? DEFAULT_LEVEL_CONFIG;
    this.stats = new StatsEngine(path.join(agentDir(arenaRoot, this.profile), 'stats.json'), this.profile, this.cfg);
    this.store = new SkillStore(skillsDir(arenaRoot));
    this.policy = new PolicyStore(policyDir(arenaRoot));
    this.ledger = new SkillLedger(path.join(agentDir(arenaRoot, this.profile), 'skill-ledger.jsonl'));
    this.opts = {
      skillTokenBudget: opts.skillTokenBudget ?? 600,
      canaryPercent: opts.canaryPercent ?? 20,
      regression: opts.regression ?? DEFAULT_REGRESSION,
      ...(opts.miner !== undefined ? { miner: opts.miner } : {}),
    };
  }

  /**
   * Ingests one arbiter verdict: stats credit (root 1.0 / child 0.5),
   * per-skill credit via ledger join, then gate evaluation.
   * Returns the decision; performs promotion itself when it fires.
   */
  ingest(score: ScoreRecord, task: string, depth = 0): LevelDecision {
    const weight = weightForDepth(depth);
    this.stats.record(score, { weight, task });

    // Per-skill credit for every version injected into that run.
    const success = score.verdict === 'success';
    for (const entry of this.ledger.all().filter((l) => l.runId === score.runId)) {
      this.store.creditUse(entry.skillId, entry.version, success);
    }

    // Inconclusive runs never drive levels.
    if (score.verdict === 'inconclusive') {
      return evaluateLevelUp(this.stats.load(), this.cfg, this.stats.rollingRate(this.stats.load()));
    }

    const stats = this.stats.load();
    const decision = evaluateLevelUp(stats, this.cfg, this.stats.rollingRate(stats));
    if (decision.promote) {
      const fromLevel = stats.level;
      this.stats.save(this.stats.consumeForPromotion(stats));
      appendFileSync(
        path.join(agentDir(this.arenaRoot, this.profile), 'level-history.jsonl'),
        `${JSON.stringify({ fromLevel, toLevel: stats.level, ts: new Date().toISOString(), evidence: decision.evidence })}\n`,
        { flag: 'a' },
      );
    }
    return decision;
  }

  /** Deterministic runtime selection for a session start. */
  selectForRun(runId: string, input: Omit<SelectionInput, 'tokenBudget' | 'canaryRoll' | 'canaryPercent'>): SkillInjection {
    const pointer = this.policy.current();
    const loaded: Array<{ data: SkillData; body: string }> = [];
    for (const [id, version] of Object.entries(pointer.activeSkillVersions)) {
      const s = this.store.load(id);
      if (!s || s.data.version !== version) {
        // Pointer references a version whose canonical file differs - trust
        // the store's current tip but only if statuses allow.
        if (s && (s.data.status === 'active' || s.data.status === 'candidate')) loaded.push(s);
        continue;
      }
      loaded.push(s);
    }
    const roll = deterministicRoll(runId);
    const selections = selectSkills(loaded, {
      ...input,
      tokenBudget: this.opts.skillTokenBudget,
      canaryRoll: roll,
      canaryPercent: this.opts.canaryPercent,
    });
    this.ledger.record(runId, selections.map((s) => ({ skillId: s.data.id, version: s.data.version })));
    return { selections, runId };
  }

  /** Mines a SKILL.md draft from a scored trajectory (requires a MinerFn). */
  async mineFromRun(req: { task: string; trajectory: TrajectoryView; score: ScoreRecord }): Promise<SkillData> {
    const { task, trajectory, score } = req;
    if (!this.opts.miner) throw new Error('no MinerFn configured');
    if (score.verdict !== 'success' && score.verdict !== 'partial') {
      throw new Error(`refusing to mine from verdict '${score.verdict}'`);
    }
    const draft = await this.opts.miner({ task: req.task, trajectory: req.trajectory, verdict: score.verdict });
    const { data } = this.store.create({
      title: draft.title,
      description: draft.description,
      body: draft.body,
      triggers: draft.triggers,
      minedFromRunId: score.runId,
    });
    return data;
  }

  /** draft -> candidate (contradiction-gated). */
  promoteToCandidate(id: string): { ok: boolean; reason: string } {
    const conflict = findContradiction(this.store, this.policy, id);
    if (conflict !== undefined) {
      return { ok: false, reason: `contradicts active skill '${conflict.conflictingWith}' (similarity ${conflict.similarity})` };
    }
    this.store.setStatus(id, this.store.load(id)!.data.version, 'candidate', 'promoted to canary candidate');
    return { ok: true, reason: 'candidate (canary)' };
  }

  /** candidate -> active under the policy pointer. */
  promoteToActive(id: string, reason = 'canary graduated'): void {
    const data = this.store.load(id)!.data;
    if (data.status !== 'candidate') throw new Error(`skill '${id}' must be candidate to activate (is ${data.status})`);
    this.policy.flip((active) => {
      active[id] = data.version;
    });
    this.store.setStatus(id, data.version, 'active', reason);
  }

  /** Regression sweep against the agent's rolling baseline. */
  sweep(): RollbackEvent[] {
    const stats = this.stats.load();
    return regressionSweep(this.store, this.policy, this.stats.rollingRate(stats), this.opts.regression);
  }
}

/** Stable pseudo-roll from the runId so replays pick identical skills. */
function deterministicRoll(runId: string): number {
  let h = 2166136261;
  for (let i = 0; i < runId.length; i++) {
    h ^= runId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 100;
}
