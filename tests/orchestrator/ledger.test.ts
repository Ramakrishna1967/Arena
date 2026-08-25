import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET_SHRINK,
  MIN_CHILD_WALL_MS,
  RunLedger,
  deriveChildBudgets,
} from '../../src/orchestrator/ledger.js';

describe('deriveChildBudgets (geometric shrink)', () => {
  it('floors the shrunk slice of remaining budgets', () => {
    const d = deriveChildBudgets(7, 9, undefined, DEFAULT_BUDGET_SHRINK);
    expect(d).toEqual({ maxSteps: 3, maxToolCalls: 4 });
  });

  it('shrinks wall clock and denies slices below usable minimum', () => {
    expect(deriveChildBudgets(10, 10, 10_000)?.wallClockMs).toBe(5000);
    expect(deriveChildBudgets(10, 10, MIN_CHILD_WALL_MS - 1)).toBeNull();
  });

  it('denies when the derived slice cannot do anything', () => {
    expect(deriveChildBudgets(1, 10, undefined)).toBeNull(); // floor(0.5)=0 steps
    expect(deriveChildBudgets(10, 1, undefined)).toBeNull();
  });

  it('RunLedger charges consumption and clamps remaining at zero', () => {
    const l = new RunLedger({ maxSteps: 4, maxToolCalls: 5 });
    expect(l.remainingSteps).toBe(4);
    l.charge(3, 2);
    expect(l.remainingSteps).toBe(1);
    expect(l.remainingToolCalls).toBe(3);
    l.charge(99, 99);
    expect(l.remainingSteps).toBe(0);
    expect(l.remainingToolCalls).toBe(0);
    expect(l.elapsedMs()).toBeLessThan(1000);
  });
});
