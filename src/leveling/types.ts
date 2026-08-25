import type { Verdict } from '../arbiter/types.js';

/** Level-up gate configuration. Defaults make single-success promotion impossible. */
export interface LevelConfig {
  /** Successes required at the current tier before promotion. >= 2 always. */
  K: number;
  /** Distinct task fingerprints required among those successes. */
  M: number;
  /** Minimum rolling success rate over the window. */
  minRate: number;
  /** Rolling window size for rates. */
  windowSize: number;
}

export const DEFAULT_LEVEL_CONFIG: LevelConfig = { K: 3, M: 2, minRate: 0.7, windowSize: 20 };

export interface WindowEntry {
  runId: string;
  verdict: Verdict;
  weight: number;
  fingerprint?: string;
  ts: string;
}

export interface AgentStats {
  profile: string;
  level: number;
  totals: { scored: number; success: number; partial: number; fail: number; inconclusive: number };
  weightedSuccesses: number;
  successesSinceLevelUp: number;
  /** fingerprint -> success count (successes only; cleared on level-up). */
  fingerprints: Record<string, number>;
  window: WindowEntry[];
}

export type SkillStatus = 'draft' | 'candidate' | 'active' | 'retired' | 'rolled_back';

export interface SkillTriggers {
  keywords: string[];
  pathGlobs: string[];
  commandPrefixes: string[];
}

/** Canonical machine-readable skill data (SKILL.md is generated from this). */
export interface SkillData {
  id: string;
  version: string;
  parentVersion?: string;
  status: SkillStatus;
  title: string;
  description: string;
  triggers: SkillTriggers;
  tokenCost: number;
  created: string;
  minedFromRunId?: string;
}

export interface LineageNode {
  version: string;
  parentVersion?: string;
  status: SkillStatus;
  createdAt: string;
  reason?: string;
  minedFromRunId?: string;
  /** Outcome tracking fed by the skill ledger. */
  stats: { uses: number; successes: number; window: boolean[] };
}

export interface SkillLineage {
  id: string;
  versions: Record<string, LineageNode>;
  tip: string;
}

export interface LedgerEntry {
  runId: string;
  skillId: string;
  version: string;
  ts: string;
}

export interface PolicyPointer {
  genId: string;
  updatedAt: string;
  /** skillId -> active version under THIS policy generation. */
  activeSkillVersions: Record<string, string>;
}
