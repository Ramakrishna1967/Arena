// Arena CLI - Layer 1: Provider Abstraction public surface.

export * from './providers/types.js';
export * from './providers/errors.js';
export * from './providers/cost.js';
export * from './providers/registry.js';
export { OpenAICompatibleAdapter, mapMessagesToOpenAI } from './providers/openai-compat.js';
export { OpenAIAdapter } from './providers/openai.js';
export { XaiAdapter } from './providers/xai.js';
export { DeepSeekAdapter } from './providers/deepseek.js';
export { AnthropicAdapter, toAnthropicRequest } from './providers/anthropic.js';
export { parseSseStream } from './providers/sse.js';
export { withRetry, DEFAULT_RETRY } from './providers/retry.js';

// Layer 2: Agent Execution Core.
export type {
  PolicyBundle,
  PermissionConfig,
  PermissionMode,
  PermissionRule,
  Budgets,
  RunOptions,
  RunResult,
  RunStatus,
  AgentEvent,
  AskHandler,
  PermissionRequest,
  ToolResult,
} from './agent/types.js';
export { defineBundle, starterBundle } from './agent/policy.js';
export { AgentExecutor } from './agent/executor.js';
export { PermissionManager } from './agent/permissions.js';
export { ToolRegistry, defaultRegistry } from './agent/tools/registry.js';
export type { ArenaTool, ToolContext, ToolKind } from './agent/tools/types.js';
export { resolveInJail } from './agent/tools/files.js';
export { shellTool } from './agent/tools/shell.js';
export { readFileTool, writeFileTool, editFileTool, listDirTool } from './agent/tools/files.js';
export { webFetchTool } from './agent/tools/web.js';
export { codeEvalTool } from './agent/tools/code.js';
export { taskCompleteTool } from './agent/tools/builtin.js';

// Layer 3 (execution side): Orchestrator + Sub-Agents.
export { ArenaOrchestrator, type OrchestratorOptions } from './orchestrator/orchestrator.js';
export {
  RunLedger,
  deriveChildBudgets,
  DEFAULT_MAX_DEPTH,
  DEFAULT_BUDGET_SHRINK,
  MIN_CHILD_WALL_MS,
} from './orchestrator/ledger.js';
export type { DerivedBudgets } from './orchestrator/ledger.js';
export type { SpawnEnv, SpawnArgs } from './orchestrator/spawn-protocol.js';

// Layer 3: Trajectory Logging + Arbiter.
export { Recorder, loadEvents, type RunMeta } from './recorder/recorder.js';
export { treeNodes, buildTrajectoryView } from './recorder/trajectory.js';
export type { TrajectoryView, TrajectoryStep, TreeNode } from './recorder/trajectory.js';
export { CHECKS, evaluateChecks } from './arbiter/checks.js';
export { Arbiter, detectProviderFault, VERDICT_THRESHOLDS } from './arbiter/arbiter.js';
export type { ScoreRunOptions, ArbiterOptions } from './arbiter/arbiter.js';
export { DEFAULT_RUBRIC, DEFAULT_RUBRIC_NAME, ensureDefaultRubric, loadRubric } from './arbiter/rubric.js';
export { llmJudge } from './arbiter/llm-judge.js';
export type { JudgeLaneConfig } from './arbiter/llm-judge.js';
export type { Rubric, RubricDimension, CheckResult, ScoreRecord, Verdict } from './arbiter/types.js';
export type { JudgeFn, JudgeRequest, JudgeResult, DimensionScore } from './arbiter/judge-types.js';

// Layer 4: Leveling + Skill Evolution.
export { LevelingEngine, type LevelingOptions, type SkillInjection } from './leveling/engine.js';
export { StatsEngine } from './leveling/stats.js';
export { evaluateLevelUp } from './leveling/gates.js';
export { SkillStore, estimateTokens, slugify, renderSkillMd } from './leveling/skill-store.js';
export { PolicyStore, SkillLedger } from './leveling/policy.js';
export { selectSkills, matchesGlob } from './leveling/selector.js';
export type { SelectionInput, SelectedSkill } from './leveling/selector.js';
export { llmSkillMiner, renderMinerPrompt } from './leveling/miner.js';
export type { MinerFn, MinerRequest, MinedDraft } from './leveling/miner.js';
export { findContradiction, regressionSweep, DEFAULT_REGRESSION } from './leveling/promotion.js';
export type { RollbackEvent, RegressionOptions } from './leveling/promotion.js';
export {
  DEFAULT_LEVEL_CONFIG,
} from './leveling/types.js';
export {
  weightForDepth,
  fingerprintTask,
  ensureArenaRoot,
} from './leveling/paths.js';
export type {
  AgentStats,
  LevelConfig,
  WindowEntry,
  SkillData,
  SkillStatus,
  SkillTriggers,
  SkillLineage,
  LineageNode,
  LedgerEntry,
  PolicyPointer,
} from './leveling/types.js';
