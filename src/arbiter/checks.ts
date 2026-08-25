import type { TrajectoryView } from '../recorder/trajectory.js';

export interface CheckOutcome {
  passed: boolean;
  details: string;
}

export interface HardCheck {
  version: number;
  description: string;
  evaluate(view: TrajectoryView): CheckOutcome;
}

/**
 * Deterministic, VERSIONED hard checks. Pure functions of the trajectory
 * view: identical runs re-evaluate to identical outcomes - that is the
 * Phase 4 determinism exit criterion for this stage.
 */
export const CHECKS: Record<string, HardCheck> = {
  run_completed: {
    version: 1,
    description: 'The run reached a completed terminal state.',
    evaluate: (v) => {
      if (v.finalStatus === undefined) return { passed: false, details: 'run has no terminal event (incomplete log?)' };
      return v.finalStatus === 'completed'
        ? { passed: true, details: `status=completed` }
        : { passed: false, details: `status=${v.finalStatus}${v.errorMessage ? ` (${v.errorMessage})` : ''}` };
    },
  },

  tolerable_tool_failures: {
    version: 1,
    description: 'Fewer than half of executed tool calls failed (0 tools = pass; pure Q&A).',
    evaluate: (v) => {
      const total = v.toolResults.length;
      if (total === 0) return { passed: true, details: 'no tool calls' };
      const failed = v.toolResults.filter((r) => !r.ok).length;
      const okRatio = (total - failed) / total;
      return okRatio >= 0.5
        ? { passed: true, details: `${total - failed}/${total} tool calls ok` }
        : { passed: false, details: `${failed}/${total} tool calls failed` };
    },
  },

  no_permission_denials: {
    version: 1,
    description: 'No tool call was blocked by the permission gate.',
    evaluate: (v) => {
      const denied = v.toolResults.filter((r) => !r.ok && r.output.startsWith('PERMISSION DENIED'));
      return denied.length === 0
        ? { passed: true, details: 'no denials' }
        : { passed: false, details: `denied: ${denied.map((d) => d.name).join(', ')}` };
    },
  },

  produced_final_answer: {
    version: 1,
    description: 'The run ended with non-empty final text.',
    evaluate: (v) =>
      v.finalText && v.finalText.trim().length > 0
        ? { passed: true, details: `${v.finalText.trim().length} chars` }
        : { passed: false, details: 'no final text' },
  },
};

export function evaluateChecks(names: string[], view: TrajectoryView) {
  return names.map((name) => {
    const check = CHECKS[name];
    if (!check) throw new Error(`unknown hard check '${name}' (registered: ${Object.keys(CHECKS).join(', ')})`);
    return { check: name, checkVersion: check.version, ...check.evaluate(view) };
  });
}
