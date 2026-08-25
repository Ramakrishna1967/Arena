import type { ProviderAdapter } from '../providers/types.js';
import { AgentExecutor } from '../agent/executor.js';
import { PermissionManager } from '../agent/permissions.js';
import { defineBundle } from '../agent/policy.js';
import type { PolicyBundle, RunResult } from '../agent/types.js';
import { ToolRegistry } from '../agent/tools/registry.js';
import type { ArenaTool } from '../agent/tools/types.js';
import { randomId } from '../agent/util.js';
import {
  DEFAULT_BUDGET_SHRINK,
  DEFAULT_MAX_DEPTH,
  MIN_CHILD_WALL_MS,
  RunLedger,
  deriveChildBudgets,
} from './ledger.js';
import { parseSpawnArgs, summarizeChildRun, type SpawnEnv } from './spawn-protocol.js';

export interface OrchestratorOptions {
  maxDepth?: number;
  budgetShrink?: number;
}

/** Root-level run id supplied by the caller (ArenaApp) for ledger linkage. */
export interface RunEnv extends SpawnEnv {
  runId?: string;
  seedMessages?: import('../agent/types.js').ChatMessage[];
}

/**
 * Owns the spawn tree. Every run gets its OWN registry clone containing a
 * depth-scoped spawn_agent tool, so a grandchild spawned by a child is
 * scoped by the CHILD's ledger and depth - never the root's.
 */
export class ArenaOrchestrator {
  private readonly defaultMaxDepth: number;
  private readonly shrink: number;

  constructor(
    private readonly adapter: ProviderAdapter,
    private readonly baseRegistry: ToolRegistry,
    private readonly permissions: PermissionManager,
    opts: OrchestratorOptions = {},
  ) {
    this.defaultMaxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.shrink = opts.budgetShrink ?? DEFAULT_BUDGET_SHRINK;
  }

  async run(task: string, bundle: PolicyBundle, env: RunEnv = {}): Promise<RunResult> {
    return this.runScoped({
      task,
      bundle,
      depth: 0,
      ledger: new RunLedger(bundle.budgets),
      env,
      ...(env.runId !== undefined ? { forcedRunId: env.runId } : {}),
      ...(env.seedMessages !== undefined ? { seedMessages: env.seedMessages } : {}),
    });
  }

  /** One node of the spawn tree: scoped registry + scoped ledger + linked meta. */
  private runScoped(ctx: {
    task: string;
    bundle: PolicyBundle;
    depth: number;
    ledger: RunLedger;
    env: SpawnEnv;
    parentRunId?: string;
    forcedRunId?: string;
    seedMessages?: import('../agent/types.js').ChatMessage[];
  }): Promise<RunResult> {
    const runId = ctx.forcedRunId ?? randomId('run');
    const cap = ctx.bundle.budgets.maxDepth ?? this.defaultMaxDepth;

    const registry = cloneRegistry(this.baseRegistry);
    if (ctx.depth < cap) {
      registry.register(this.makeSpawnTool({ runId, depth: ctx.depth, bundle: ctx.bundle, ledger: ctx.ledger, env: ctx.env }));
    }

    const executor = new AgentExecutor(this.adapter, registry, this.permissions);
    return executor.run(ctx.task, ctx.bundle, {
      cwd: ctx.env.cwd,
      signal: ctx.env.signal,
      askHandler: ctx.env.askHandler,
      onEvent: ctx.env.onEvent,
      runId,
      parentRunId: ctx.parentRunId,
      depth: ctx.depth,
      ...(ctx.seedMessages !== undefined ? { seedMessages: ctx.seedMessages } : {}),
    });
  }

  /**
   * The spawn gate. All limits are enforced HERE, pre-call:
   * depth cap -> derived budget slice -> allowlist narrowing.
   */
  private makeSpawnTool(scope: {
    runId: string;
    depth: number;
    bundle: PolicyBundle;
    ledger: RunLedger;
    env: SpawnEnv;
  }): ArenaTool {
    const self = this;
    return {
      name: 'spawn_agent',
      description:
        'Spawn a scoped sub-agent for a subtask. It inherits provider/model/permissions with a FRACTION of your remaining step/tool/time budget and a narrowed toolset.',
      kind: 'builtin',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Self-contained instructions for the sub-agent' },
          system: { type: 'string', description: 'Optional system prompt override' },
          tools: { type: 'array', items: { type: 'string' }, description: 'Optional tool subset (intersected with your own allowlist)' },
          label: { type: 'string', description: 'Short label for logs' },
        },
        required: ['task'],
      },
      execute: async (rawArgs) => {
        const cap = scope.bundle.budgets.maxDepth ?? self.defaultMaxDepth;
        if (scope.depth + 1 > cap) {
          return {
            ok: false,
            output: `SPAWN DENIED: depth limit ${cap} reached (you are at depth ${scope.depth}). Finish with what you have.`,
          };
        }

        // This spawn call itself consumes one of OUR turns/tool slots before
        // any child exists - subtract it before deriving the child slice.
        const remainingWallMs =
          scope.bundle.budgets.wallClockMs !== undefined
            ? Math.max(0, scope.bundle.budgets.wallClockMs - scope.ledger.elapsedMs())
            : undefined;
        const derived = deriveChildBudgets(
          scope.ledger.remainingSteps - 1,
          scope.ledger.remainingToolCalls - 1,
          remainingWallMs,
          self.shrink,
        );
        if (derived === null) {
          return {
            ok: false,
            output: `SPAWN DENIED: insufficient remaining budget to fund a sub-agent (needs >= ${MIN_CHILD_WALL_MS}ms and derivable steps/tools). Do the work yourself or finish.`,
          };
        }

        const argsOrErr = parseSpawnArgs(rawArgs as Record<string, unknown>);
        if (typeof argsOrErr === 'string') return { ok: false, output: argsOrErr };
        const args = argsOrErr;

        // Allowlist narrowing: requested ∩ parent-effective. spawn rights are
        // re-granted only while there is still depth headroom below the child.
        const parentEffective =
          scope.bundle.toolAllowlist.length > 0 ? [...scope.bundle.toolAllowlist] : self.baseRegistry.names();
        let childAllowed =
          args.tools !== undefined && args.tools.length > 0
            ? args.tools.filter((t) => parentEffective.includes(t))
            : [...parentEffective];
        childAllowed = childAllowed.filter((t) => t !== 'spawn_agent' && t !== 'task_complete');
        if (scope.depth + 1 < cap) childAllowed.push('spawn_agent');
        childAllowed.push('task_complete');

        const childBudgets: PolicyBundle['budgets'] = {
          ...scope.bundle.budgets,
          maxSteps: derived.maxSteps,
          maxToolCalls: derived.maxToolCalls,
          ...(derived.wallClockMs !== undefined ? { wallClockMs: derived.wallClockMs } : {}),
        };
        const childBundle = defineBundle({
          ...scope.bundle,
          id: randomId('gen'),
          ...(args.system !== undefined ? { system: args.system } : {}),
          toolAllowlist: childAllowed,
          budgets: childBudgets,
        });

        let result: RunResult;
        try {
          result = await self.runScoped({
            task: args.task,
            bundle: childBundle,
            depth: scope.depth + 1,
            ledger: new RunLedger(childBudgets),
            env: scope.env,
            parentRunId: scope.runId,
          });
        } catch (err) {
          return { ok: false, output: `spawn_agent crashed: ${err instanceof Error ? err.message : String(err)}` };
        }

        // Charge actual consumption back to OUR ledger so later siblings see it.
        scope.ledger.charge(result.steps, result.toolCallsExecuted + 1);

        return {
          ok: result.status === 'completed',
          output: summarizeChildRun(args, result),
          data: { childRunId: result.runId, status: result.status },
        };
      },
    };
  }
}

function cloneRegistry(base: ToolRegistry): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of base.names()) {
    const t = base.get(name);
    if (t) reg.register(t);
  }
  return reg;
}
