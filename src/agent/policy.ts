import { deepFreeze } from './util.js';
import type { PolicyBundle } from './types.js';

/**
 * Bundle factory + deep freeze. Mutation attempts fail silently in sloppy
 * mode and throw in strict mode - either way the bound snapshot cannot drift.
 */
export function defineBundle(b: PolicyBundle): Readonly<PolicyBundle> {
  return deepFreeze(b);
}

/** Sensible starting point; callers override provider/model/permissions. */
export function starterBundle(patch: Partial<PolicyBundle> & Pick<PolicyBundle, 'provider' | 'model'>): Readonly<PolicyBundle> {
  return defineBundle({
    id: patch.id ?? 'gen-local-0',
    version: patch.version ?? '0.1.0',
    system: patch.system,
    temperature: patch.temperature,
    maxTokensPerTurn: patch.maxTokensPerTurn ?? 4096,
    toolAllowlist: patch.toolAllowlist ?? [],
    permissions: patch.permissions ?? {
      default: 'allow',
      rules: [
        { tool: 'web_fetch', mode: 'allow' },
        { tool: 'code_eval', mode: 'allow' },
      ],
    },
    budgets: patch.budgets ?? { maxSteps: 16, maxToolCalls: 48, maxDepth: 4 },
    ...patch,
  });
}
