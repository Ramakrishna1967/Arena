import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from '../agent/types.js';
import type { TokenUsage } from '../providers/types.js';
import { loadEvents } from '../recorder/recorder.js';
import { buildTrajectoryView, treeNodes, type TrajectoryView } from '../recorder/trajectory.js';
import { evaluateChecks } from './checks.js';
import type { JudgeFn, JudgeResult } from './judge-types.js';
import type { JudgeLaneConfig } from './llm-judge.js';
import { llmJudge } from './llm-judge.js';
import { DEFAULT_RUBRIC_NAME, ensureDefaultRubric, loadRubric } from './rubric.js';
import type { CheckResult, ScoreRecord, Verdict } from './types.js';

export const VERDICT_THRESHOLDS = { success: 0.7, partial: 0.4 } as const;

/**
 * Patterns whose presence in a run's error message marks the failure as
 * PROVIDER-attributable (L1 fault taxonomy leaked to the surface). Such
 * runs score `inconclusive` and are excluded from agent-level stats -
 * the Arbiter must not penalize the agent for our infrastructure.
 */
const PROVIDER_FAULT_PATTERNS: Array<[RegExp, string]> = [
  [/rate limit/i, 'rate_limited'],
  [/upstream failure|overloaded/i, 'transport_retryable'],
  [/timed? ?out/i, 'timeout'],
  [/network failure|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT/i, 'transport_retryable'],
  [/unnormalizable|schema problem \(4\d\d\)/i, 'schema_violation'],
];

export function detectProviderFault(view: TrajectoryView): string | undefined {
  if (view.finalStatus !== 'error' || !view.errorMessage) return undefined;
  for (const [pattern, kind] of PROVIDER_FAULT_PATTERNS) {
    if (pattern.test(view.errorMessage)) return kind;
  }
  return undefined;
}

export interface ArbiterOptions {
  /** Arena state root; rubrics live in <arenaRoot>/rubrics. */
  arenaRoot?: string;
  /** Injectable judge - an LLM meta-lane config or a stub for tests. */
  judge?: JudgeFn | JudgeLaneConfig;
}

export interface ScoreRunOptions {
  rubricName?: string;
  targetRunId?: string;
  /** Fixed clock for deterministic tests; default Date.now. */
  now?: () => Date;
  /** Write scores/<rubric>.<runId>.json when input was a run directory (default true). */
  persist?: boolean;
}

/**
 * L3 Arbiter - a DISTINCT, inspectable component. Two stages:
 *   1. deterministic hard checks (versioned, pure functions of the trajectory)
 *   2. rubric judge on the meta lane - ONLY consulted when hard checks pass
 *      (a hard fail is decisive; judging it wastes money)
 *
 * Verdict rules (explicit, ordered):
 *   provider-attributable error -> inconclusive (excluded from agent stats)
 *   any hard check failed       -> fail        (confidence 0.99)
 *   judge weighted overall      -> >=0.70 success | >=0.40 partial | else fail (confidence 0.75)
 *   no judge available          -> success on hard-pass alone (LOW confidence 0.35)
 */
export class Arbiter {
  private readonly judgeFn?: JudgeFn;
  private readonly judgeModel?: string;
  readonly arenaRoot: string;

  constructor(opts: ArbiterOptions = {}) {
    this.arenaRoot = opts.arenaRoot ?? '.';
    ensureDefaultRubric(this.arenaRoot);
    if (opts.judge !== undefined) {
      if (typeof opts.judge === 'function') {
        this.judgeFn = opts.judge;
      } else {
        this.judgeFn = llmJudge(opts.judge);
        this.judgeModel = `${opts.judge.provider}/${opts.judge.model}`;
      }
    }
  }

  async scoreRun(input: string | AgentEvent[], o: ScoreRunOptions = {}): Promise<ScoreRecord> {
    const events = loadEvents(input);
    const runDir = typeof input === 'string' && !input.endsWith('events.jsonl') ? input : undefined;

    const nodes = treeNodes(events);
    const targetRunId = o.targetRunId ?? nodes.find((n) => n.parentId === undefined)?.runId;
    if (!targetRunId) throw new Error('no root run found in event stream');

    const view = buildTrajectoryView(events, targetRunId);
    const rubricName = o.rubricName ?? DEFAULT_RUBRIC_NAME;
    const rubric = loadRubric(this.arenaRoot, rubricName);

    // Stage 1: deterministic hard gates.
    const checkResults: CheckResult[] = evaluateChecks(rubric.hardChecks, view);
    const hardPassed = checkResults.every((c) => c.passed);

    const excludedFactors: string[] = [];
    const faultKind = detectProviderFault(view);
    if (faultKind !== undefined) excludedFactors.push(`provider_fault:${faultKind}`);

    let verdict: Verdict;
    let confidence: number;
    let judgeSection: ScoreRecord['judge'];
    let judgeUsage: TokenUsage | undefined;

    if (faultKind !== undefined) {
      verdict = 'inconclusive';
      confidence = 0.95;
    } else if (!hardPassed) {
      verdict = 'fail';
      confidence = 0.99;
    } else if (this.judgeFn === undefined) {
      verdict = 'success';
      confidence = 0.35;
    } else {
      let judgeResult: JudgeResult | undefined;
      try {
        judgeResult = await this.judgeFn({ task: view.task, dimensions: rubric.dimensions, trajectory: view });
      } catch (err) {
        // A failing judge lane must never corrupt scoring - fall back to
        // hard-only with an explicit exclusion note.
        excludedFactors.push(`judge_error:${err instanceof Error ? err.message : String(err)}`);
      }

      if (judgeResult === undefined) {
        verdict = 'success';
        confidence = 0.35;
      } else {
        const dims: Record<string, { score: number; rationale: string }> = {};
        for (const [id, v] of Object.entries(judgeResult.dimensions)) dims[id] = { ...v };
        const weightedOverall =
          Math.round(
            rubric.dimensions.reduce((sum, d) => sum + d.weight * ((dims[d.id]?.score ?? 0) / 10), 0) * 10000,
          ) / 10000;
        verdict =
          weightedOverall >= VERDICT_THRESHOLDS.success
            ? 'success'
            : weightedOverall >= VERDICT_THRESHOLDS.partial
              ? 'partial'
              : 'fail';
        confidence = 0.75;
        judgeSection = {
          dimensions: dims,
          weightedOverall,
          overallComment: judgeResult.overallComment,
          ...(this.judgeModel !== undefined ? { model: this.judgeModel } : {}),
        };
        judgeUsage = judgeResult.usage;
      }
    }

    const record: ScoreRecord = {
      schemaVersion: 1,
      runId: targetRunId,
      rubric: { name: rubric.name, version: rubric.version },
      hardChecks: checkResults,
      hardPassed,
      ...(judgeSection !== undefined ? { judge: judgeSection } : {}),
      verdict,
      confidence,
      excludedFactors,
      ...(judgeUsage !== undefined ? { judgeUsage } : {}),
      scoredAt: (o.now ?? (() => new Date()))().toISOString(),
    };

    if (runDir !== undefined && o.persist !== false) {
      const scoresDir = path.join(runDir, 'scores');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(scoresDir, { recursive: true });
      const file = path.join(scoresDir, `${record.rubric.name}.${record.runId}.json`);
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    }
    return record;
  }
}
