import type { Budgets } from '../agent/types.js';

export interface DerivedBudgets {
  maxSteps: number;
  maxToolCalls: number;
  wallClockMs?: number;
}

/**
 * Per-run consumption accounting. The root ledger starts from the bundle
 * budgets; each spawn derives a child ledger from the PARENT's remaining,
 * then charges actual child consumption back after the child finishes.
 */
export class RunLedger {
  private stepsUsed = 0;
  private callsUsed = 0;
  private readonly startedAt = Date.now();

  constructor(public readonly budgets: Budgets) {}

  /** Milliseconds elapsed since this ledger was created. */
  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  get remainingSteps(): number {
    return Math.max(0, this.budgets.maxSteps - this.stepsUsed);
  }

  get remainingToolCalls(): number {
    return Math.max(0, this.budgets.maxToolCalls - this.callsUsed);
  }

  charge(steps: number, toolCalls: number): void {
    this.stepsUsed += steps;
    this.callsUsed += toolCalls;
  }
}

export const DEFAULT_MAX_DEPTH = 4;
export const DEFAULT_BUDGET_SHRINK = 0.5;
/** Below this a child cannot do anything meaningful - deny instead. */
export const MIN_CHILD_WALL_MS = 250;

/**
 * Geometric shrink: a child never gets more than `shrink` of its parent's
 * REMAINING budgets. Returns null when the derived slice is unusable - the
 * spawn must be denied BEFORE any provider call (enforced pre-call).
 */
export function deriveChildBudgets(
  remainingSteps: number,
  remainingToolCalls: number,
  remainingWallMs: number | undefined,
  shrink: number = DEFAULT_BUDGET_SHRINK,
): DerivedBudgets | null {
  const maxSteps = Math.floor(remainingSteps * shrink);
  const maxToolCalls = Math.floor(remainingToolCalls * shrink);
  if (maxSteps < 1 || maxToolCalls < 1) return null;
  let wallClockMs: number | undefined;
  if (remainingWallMs !== undefined) {
    wallClockMs = Math.floor(remainingWallMs * shrink);
    if (wallClockMs < MIN_CHILD_WALL_MS) return null;
  }
  return { maxSteps, maxToolCalls, wallClockMs };
}
