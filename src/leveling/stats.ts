import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ScoreRecord } from '../arbiter/types.js';
import { fingerprintTask, isPositiveVerdict } from './paths.js';
import type { AgentStats, LevelConfig, WindowEntry } from './types.js';
import { DEFAULT_LEVEL_CONFIG } from './types.js';

/**
 * Per-profile usage statistics - the evidence base for level gates.
 * Append-derived rollup persisted as JSON; rebuildable from score history.
 */
export class StatsEngine {
  constructor(
    private readonly filePath: string,
    private readonly profile = 'default',
    private readonly cfg: LevelConfig = DEFAULT_LEVEL_CONFIG,
  ) {}

  load(): AgentStats {
    if (existsSync(this.filePath)) {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as AgentStats;
    }
    return {
      profile: this.profile,
      level: 1,
      totals: { scored: 0, success: 0, partial: 0, fail: 0, inconclusive: 0 },
      weightedSuccesses: 0,
      successesSinceLevelUp: 0,
      fingerprints: {},
      window: [],
    };
  }

  save(stats: AgentStats): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(stats, null, 2)}\n`, 'utf8');
  }

  /** Ingests one ScoreRecord. `task` supplies the fingerprint when present. */
  record(score: ScoreRecord, opts: { weight: number; task?: string }): AgentStats {
    const s = this.load();
    const positive = isPositiveVerdict(score.verdict);
    const entry: WindowEntry = {
      runId: score.runId,
      verdict: score.verdict,
      weight: opts.weight,
      ...(opts.task !== undefined ? { fingerprint: fingerprintTask(opts.task) } : {}),
      ts: score.scoredAt,
    };

    s.totals.scored += 1;
    s.totals[score.verdict] += 1;
    if (score.verdict === 'inconclusive') {
      // Excluded from leveling entirely (provider faults are not progress).
      this.pushWindow(s, entry);
      this.save(s);
      return s;
    }

    const credit = positive ? opts.weight : 0;
    s.weightedSuccesses += credit;

    if (positive) {
      s.successesSinceLevelUp += opts.weight;
      if (entry.fingerprint !== undefined) {
        s.fingerprints[entry.fingerprint] = (s.fingerprints[entry.fingerprint] ?? 0) + 1;
      }
    }
    this.pushWindow(s, entry);
    this.save(s);
    return s;
  }

  /** Level-up consumed the accumulated evidence at the old tier. */
  consumeForPromotion(stats: AgentStats): AgentStats {
    stats.level += 1;
    stats.successesSinceLevelUp = 0;
    stats.fingerprints = {};
    return stats;
  }

  rollingRate(stats: AgentStats): number | null {
    const scored = stats.window.filter((w) => w.verdict !== 'inconclusive');
    if (scored.length === 0) return null;
    const sum = scored.reduce((acc, w) => acc + (isPositiveVerdict(w.verdict) ? w.weight : 0), 0);
    return Math.round((sum / scored.length) * 10000) / 10000;
  }

  distinctFingerprints(stats: AgentStats): number {
    return Object.keys(stats.fingerprints).length;
  }

  private pushWindow(stats: AgentStats, entry: WindowEntry): void {
    stats.window.push(entry);
    const cap = Math.max(this.cfg.windowSize, 1);
    while (stats.window.length > cap) stats.window.shift();
  }
}
