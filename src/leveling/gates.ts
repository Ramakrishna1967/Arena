import type { AgentStats, LevelConfig } from './types.js';

export interface LevelDecision {
  promote: boolean;
  reason: string;
  evidence: {
    successesSinceLevelUp: number;
    requiredSuccesses: number;
    distinctFingerprints: number;
    requiredFingerprints: number;
    rollingRate: number | null;
    requiredRate: number;
  };
}

/**
 * THE GATE. Promotion needs ALL of:
 *   - weighted successes at this tier >= K   (K defaults to 3 -> a single
 *     success can NEVER promote, enforced structurally)
 *   - >= M DISTINCT task fingerprints        (no grinding one easy task)
 *   - rolling success rate >= minRate
 *
 * Inconclusive runs never count (provider faults are not progress).
 */
export function evaluateLevelUp(stats: AgentStats, cfg: LevelConfig, rollingRate: number | null): LevelDecision {
  const distinct = Object.keys(stats.fingerprints).length;
  const rate = rollingRate ?? 0;

  const evidence = {
    successesSinceLevelUp: Math.round(stats.successesSinceLevelUp * 100) / 100,
    requiredSuccesses: cfg.K,
    distinctFingerprints: distinct,
    requiredFingerprints: cfg.M,
    rollingRate,
    requiredRate: cfg.minRate,
  };

  if (stats.successesSinceLevelUp < cfg.K) {
    return { promote: false, reason: `successes ${evidence.successesSinceLevelUp}/${cfg.K}`, evidence };
  }
  if (distinct < cfg.M) {
    return { promote: false, reason: `distinct tasks ${distinct}/${cfg.M} (variety gate)`, evidence };
  }
  if (rollingRate === null || rate < cfg.minRate) {
    return { promote: false, reason: `rolling rate ${rate}/${cfg.minRate}`, evidence };
  }
  return { promote: true, reason: `met K=${cfg.K} across M=${distinct} tasks at rate ${rate}`, evidence };
}
