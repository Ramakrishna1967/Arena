import type { TokenUsage } from '../providers/types.js';

export type Verdict = 'success' | 'partial' | 'fail' | 'inconclusive';

export interface RubricDimension {
  id: string;
  description: string;
  weight: number; // sums to ~1 across dimensions
}

export interface Rubric {
  name: string;
  /** Semver-ish string, pinned verbatim into every ScoreRecord. */
  version: string;
  description: string;
  dimensions: RubricDimension[];
  hardChecks: string[];
}

export interface CheckResult {
  check: string;
  checkVersion: number;
  passed: boolean;
  details: string;
}

/**
 * Explicit, inspectable scoring output - the ONLY way a verdict enters the
 * leveling engine later (L4 consumes ScoreRecords, nothing implicit).
 */
export interface ScoreRecord {
  schemaVersion: 1;
  runId: string;
  rubric: { name: string; version: string };
  hardChecks: CheckResult[];
  hardPassed: boolean;
  judge?: {
    dimensions: Record<string, { score: number; rationale: string }>;
    weightedOverall: number;
    overallComment: string;
    model?: string;
  };
  verdict: Verdict;
  confidence: number;
  /** e.g. provider-attributable failures excluded from agent scoring. */
  excludedFactors: string[];
  judgeUsage?: TokenUsage;
  scoredAt: string;
}
