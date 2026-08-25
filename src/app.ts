import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderAdapter } from './providers/types.js';
import { createProvider } from './providers/registry.js';
import type { ChatMessage } from './agent/types.js';
import { AgentEvent, RunResult } from './agent/types.js';
import { starterBundle } from './agent/policy.js';
import { ArenaOrchestrator } from './orchestrator/orchestrator.js';
import { PermissionManager } from './agent/permissions.js';
import { defaultRegistry } from './agent/tools/registry.js';
import { Recorder, loadEvents } from './recorder/recorder.js';
import { buildTrajectoryView, rebuildMessages, treeNodes } from './recorder/trajectory.js';
import { Arbiter } from './arbiter/arbiter.js';
import type { JudgeFn } from './arbiter/judge-types.js';
import type { JudgeLaneConfig } from './arbiter/llm-judge.js';
import type { ScoreRecord } from './arbiter/types.js';
import { LevelingEngine } from './leveling/engine.js';
import type { MinerFn } from './leveling/miner.js';
import { llmSkillMiner } from './leveling/miner.js';
import type { SelectedSkill } from './leveling/selector.js';
import type { LevelDecision } from './leveling/gates.js';
import { withArenaLock } from './persistence/atomic.js';

const BASE_SYSTEM = [
  'You are Arena, a pragmatic terminal coding agent.',
  'Work through tools; keep outputs tight; finish with a clear summary.',
].join('\n');

export interface ArenaAppConfig {
  arenaRoot?: string;
  profile?: string;
  worker: { provider: Parameters<typeof createProvider>[0]; model: string; apiKey?: string; baseUrl?: string };
  judgeLane?: JudgeLaneConfig | JudgeFn;
  minerLane?: JudgeLaneConfig | MinerFn;
  maxDepth?: number;
  /** Test seam: supply the worker adapter directly (no network). */
  adapterFactory?: () => ProviderAdapter;
}

export interface RunOutcome {
  runId: string;
  runDir: string;
  result: RunResult;
  record: ScoreRecord;
  decision: LevelDecision;
  injected: Array<{ id: string; version: string; title: string }>;
}

/**
 * The application: glues L1-L4 into one usable object. The CLI is a thin
 * shell over this; tests use it directly with injected adapters/stubs.
 */
export class ArenaApp {
  readonly arenaRoot: string;
  readonly engine: LevelingEngine;
  readonly arbiter: Arbiter;
  private orchestratorInstance?: ArenaOrchestrator;
  private readonly cfg: ArenaAppConfig;

  constructor(cfg: ArenaAppConfig) {
    this.cfg = cfg;
    this.arenaRoot = cfg.arenaRoot ?? path.join(os.homedir(), '.arena');
    for (const sub of ['agents', 'skills', 'policy', 'runs', 'rubrics']) {
      const dir = path.join(this.arenaRoot, sub);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    const miner = cfg.minerLane !== undefined ? (typeof cfg.minerLane === 'function' ? cfg.minerLane : llmSkillMiner(cfg.minerLane)) : undefined;
    this.engine = new LevelingEngine(this.arenaRoot, {
      profile: cfg.profile,
      ...(cfg.minerLane !== undefined ? { miner } : {}),
    });
    this.arbiter = new Arbiter({ arenaRoot: this.arenaRoot, ...(cfg.judgeLane !== undefined ? { judge: cfg.judgeLane } : {}) });
  }

  /**
   * Lazy worker construction: inspection commands (status/skills/runs/why)
   * must work WITHOUT any API key - credentials are only demanded when a
   * task will actually hit a provider.
   */
  private ensureOrchestrator(): ArenaOrchestrator {
    if (this.orchestratorInstance === undefined) {
      const adapter =
        this.cfg.adapterFactory !== undefined
          ? this.cfg.adapterFactory()
          : createProvider(this.cfg.worker.provider, { apiKey: this.cfg.worker.apiKey, baseUrl: this.cfg.worker.baseUrl });
      this.orchestratorInstance = new ArenaOrchestrator(
        adapter,
        defaultRegistry(),
        new PermissionManager({ default: 'allow', rules: [{ tool: 'web_fetch', mode: 'allow' }, { tool: 'code_eval', mode: 'allow' }] }),
        { ...(this.cfg.maxDepth !== undefined ? { maxDepth: this.cfg.maxDepth } : {}) },
      );
    }
    return this.orchestratorInstance;
  }

  /** Full loop: select skills -> run (recorded) -> score -> level ingest. */
  async runTask(
    task: string,
    opts: { cwd?: string; signal?: AbortSignal; onEvent?: (e: AgentEvent) => void; maxSteps?: number; maxToolCalls?: number } = {},
  ): Promise<RunOutcome> {
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const injection = this.engine.selectForRun(runId, { taskText: task, ...(opts.cwd !== undefined ? { path: opts.cwd } : {}) });

    const bundle = starterBundle({
      provider: this.cfg.worker.provider,
      model: this.cfg.worker.model,
      system: renderSkillBlock(BASE_SYSTEM, injection.selections),
      budgets: {
        maxSteps: opts.maxSteps ?? 24,
        maxToolCalls: opts.maxToolCalls ?? 64,
        maxDepth: this.cfg.maxDepth ?? 4,
      },
    });

    const runDir = path.join(this.arenaRoot, 'runs', runId);
    const recorder = new Recorder(runDir);
    const chained = (e: AgentEvent): void => {
      recorder.write(e);
      opts.onEvent?.(e);
    };

    const result = await this.ensureOrchestrator().run(task, bundle, {
      cwd: opts.cwd,
      signal: opts.signal,
      onEvent: chained,
      runId,
    });
    recorder.finalize();

    // Scoring + leveling are STATE MUTATIONS -> serialized by the arena lock.
    const record = await this.arbiter.scoreRun(runDir, { targetRunId: runId });
    const decision = await withArenaLock(this.arenaRoot, async () => this.engine.ingest(record, task));

    return {
      runId,
      runDir,
      result,
      record,
      decision,
      injected: injection.selections.map((s) => ({ id: s.data.id, version: s.data.version, title: s.data.title })),
    };
  }

  /** Cold-start resume: continue a previous session from JSONL alone. */
  async resumeRun(prevRunDir: string, followUp: string, opts: { signal?: AbortSignal; onEvent?: (e: AgentEvent) => void } = {}): Promise<RunOutcome> {
    const events = loadEvents(prevRunDir);
    const root = treeNodes(events).find((n) => n.parentId === undefined);
    if (!root) throw new Error(`no root run in ${prevRunDir}`);
    const priorMessages = rebuildMessages(events, root.runId);
    const seeded: ChatMessage[] = [...priorMessages, { role: 'user', text: followUp }];

    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const injection = this.engine.selectForRun(runId, { taskText: `${root.task ?? ''} ${followUp}` });
    const bundle = starterBundle({
      provider: this.cfg.worker.provider,
      model: this.cfg.worker.model,
      system: renderSkillBlock(BASE_SYSTEM, injection.selections),
      budgets: { maxSteps: 24, maxToolCalls: 64, maxDepth: this.cfg.maxDepth ?? 4 },
    });

    const runDir = path.join(this.arenaRoot, 'runs', runId);
    const recorder = new Recorder(runDir);
    const chained = (e: AgentEvent): void => {
      recorder.write(e);
      opts.onEvent?.(e);
    };
    const result = await this.ensureOrchestrator().run(followUp, bundle, { signal: opts.signal, onEvent: chained, runId, seedMessages: seeded });
    recorder.finalize();

    const record = await this.arbiter.scoreRun(runDir, { targetRunId: runId });
    const decision = await withArenaLock(this.arenaRoot, async () => this.engine.ingest(record, followUp));
    void buildTrajectoryView;
    return { runId, runDir, result, record, decision, injected: injection.selections.map((s) => ({ id: s.data.id, version: s.data.version, title: s.data.title })) };
  }

  /** Locked single-shot ingest for external callers/tests. */
  async ingestScore(score: ScoreRecord, task: string, depth = 0): Promise<LevelDecision> {
    return withArenaLock(this.arenaRoot, async () => this.engine.ingest(score, task, depth));
  }

  status(): { level: number; rollingRate: number | null; totals: unknown; activeSkills: Record<string, string> } {
    const s = this.engine.stats.load();
    return {
      level: s.level,
      rollingRate: this.engine.stats.rollingRate(s),
      totals: s.totals,
      activeSkills: this.engine.policy.current().activeSkillVersions,
    };
  }

  listRuns(): Array<{ runId: string; status?: string; startedAt?: string; dir: string }> {
    const runsDir = path.join(this.arenaRoot, 'runs');
    if (!existsSync(runsDir)) return [];
    return readdirSync(runsDir)
      .map((name) => path.join(runsDir, name))
      .filter((dir) => existsSync(path.join(dir, 'meta.json')))
      .map((dir) => ({ dir, ...(JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as { rootRunId?: string; status?: string; startedAt?: string }) }))
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      .map(({ dir, status, startedAt }) => ({ runId: path.basename(dir), ...(startedAt !== undefined ? { startedAt } : {}), ...(status !== undefined ? { status } : {}), dir }));
  }
}

/** Injected skills become part of the bound system prompt - the visible lever. */
export function renderSkillBlock(base: string, selections: SelectedSkill[]): string {
  if (selections.length === 0) return base;
  const block = selections
    .map((s) => `## Skill: ${s.data.title} (${s.data.id}@${s.data.version})\n${s.body}`)
    .join('\n\n');
  return `${base}\n\n# Active Skills (proven playbooks - follow them)\n\n${block}`;
}
