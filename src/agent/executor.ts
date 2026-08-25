import type { ProviderAdapter, ChatMessage, NormalizedToolCall, TokenUsage, StreamEvent } from '../providers/types.js';
import { estimateCost } from '../providers/cost.js';
import { isAbortError } from '../providers/errors.js';
import { PermissionManager } from './permissions.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';
import type { AgentEvent, EventMeta, PolicyBundle, RawAgentEvent, RunOptions, RunResult, RunStatus } from './types.js';
import { randomId, truncate } from './util.js';

/** Output preview length embedded in tool_result events (JSONL replay fidelity vs size). */
export const EVENT_OUTPUT_PREVIEW_CHARS = 800;

/**
 * The plan ▸ act ▸ observe loop. Exactly one immutable PolicyBundle binds to
 * a run. Emits AgentEvents (stamped with runId/parentId/depth) through
 * opts.onEvent for renderers and (later) the L3 recorder. Abort semantics:
 * external signal OR wall-clock budget both flip an internal controller
 * shared with the provider request and all in-flight tool executions.
 */
export class AgentExecutor {
  constructor(
    private readonly adapter: ProviderAdapter,
    private readonly registry: ToolRegistry,
    private readonly permissions: PermissionManager,
  ) {}

  async run(task: string, bundle: PolicyBundle, opts: RunOptions = {}): Promise<RunResult> {
    const meta: EventMeta = {
      runId: opts.runId ?? randomId('run'),
      parentId: opts.parentRunId,
      depth: opts.depth ?? 0,
    };
    const emit = (e: RawAgentEvent): void => opts.onEvent?.({ ...e, ...meta } as AgentEvent);

    // Internal abort plumbing: external signal and wall-clock feed it.
    const internal = new AbortController();
    const onExternalAbort = (): void => internal.abort(opts.signal?.reason ?? new DOMException('aborted by user', 'AbortError'));
    if (opts.signal) {
      if (opts.signal.aborted) onExternalAbort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    let wallClockFired = false;
    let wallTimer: NodeJS.Timeout | undefined;
    if (bundle.budgets.wallClockMs !== undefined) {
      wallTimer = setTimeout(() => {
        wallClockFired = true;
        internal.abort(new DOMException(`wall clock budget of ${bundle.budgets.wallClockMs}ms exceeded`, 'AbortError'));
      }, bundle.budgets.wallClockMs);
    }

    const cwd = opts.cwd ?? process.cwd();
    const toolCtx: ToolContext = { cwd, signal: internal.signal, fetchImpl: (...a) => globalThis.fetch(...a) };

    const transcript: ChatMessage[] = [{ role: 'user', text: task }];
    const usageByTurn: TokenUsage[] = [];
    let steps = 0;
    let toolCallsExecuted = 0;

    emit({ type: 'run_start', task });

    const finishRun = (status: RunStatus, finalText?: string, errorMessage?: string): RunResult => {
      if (wallTimer) clearTimeout(wallTimer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
      const totalUsage = usageByTurn.length
        ? {
            inputTokens: usageByTurn.reduce((s, u) => s + u.inputTokens, 0),
            outputTokens: usageByTurn.reduce((s, u) => s + u.outputTokens, 0),
          }
        : undefined;
      const costUsd = totalUsage ? estimateCost(bundle.provider, bundle.model, totalUsage)?.amount : undefined;
      emit({ type: 'run_end', status, finalText, errorMessage });
      return {
        runId: meta.runId,
        status,
        finalText,
        errorMessage,
        steps,
        toolCallsExecuted,
        totalUsage,
        costUsd,
        transcript,
      };
    };

    try {
      for (let step = 1; step <= bundle.budgets.maxSteps; step++) {
        if (internal.signal.aborted) return finishRun('aborted');
        steps = step;
        emit({ type: 'step_start', step });

        const turn = await this.turn(transcript, bundle, toolCtx, emit);
        usageByTurn.push(...turn.usage);
        emit({ type: 'step_end', step, usage: turn.usage[0] });

        if (turn.calls.length === 0) {
          return finishRun('completed', turn.text);
        }

        transcript.push({ role: 'assistant', text: turn.text, toolCalls: turn.calls });

        let taskCompleteSummary: string | undefined;
        for (const call of turn.calls) {
          const outcome = await this.executeToolCall(call, bundle, toolCtx, opts, emit);
          toolCallsExecuted += 1;
          transcript.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            text: outcome.output,
            isError: !outcome.ok,
          });
          if (call.name === 'task_complete' && outcome.ok) {
            taskCompleteSummary = outcome.output;
          }
        }
        if (taskCompleteSummary !== undefined) {
          return finishRun('completed', taskCompleteSummary);
        }

        // Budget checks that end the run BEFORE the next provider round-trip.
        if (toolCallsExecuted >= bundle.budgets.maxToolCalls) {
          return finishRun('budget_exhausted', undefined, `maxToolCalls=${bundle.budgets.maxToolCalls} reached`);
        }
      }
      return finishRun('budget_exhausted', undefined, 'step budget exhausted');
    } catch (err) {
      if (isAbortError(err) || internal.signal.aborted) {
        const msg =
          wallClockFired
            ? 'wall clock budget exceeded'
            : err instanceof Error
              ? err.message
              : 'aborted';
        return finishRun('aborted', undefined, msg);
      }
      const message = err instanceof Error ? err.message : String(err);
      return finishRun('error', undefined, message);
    }
  }

  /** One provider round-trip; streams events out, buffers calls. */
  private async *streamTurn(
    transcript: ChatMessage[],
    bundle: PolicyBundle,
    ctx: ToolContext,
  ): AsyncGenerator<StreamEvent> {
    const req = {
      model: bundle.model,
      messages: transcript,
      tools: this.registry.schemasFor(bundle),
      system: bundle.system,
      temperature: bundle.temperature,
      maxTokens: bundle.maxTokensPerTurn,
      stream: true as const,
      signal: ctx.signal,
    };
    yield* this.adapter.complete(req);
  }

  private async turn(
    transcript: ChatMessage[],
    bundle: PolicyBundle,
    ctx: ToolContext,
    emit: (e: RawAgentEvent) => void,
  ): Promise<{ text: string; calls: NormalizedToolCall[]; usage: TokenUsage[] }> {
    let text = '';
    const calls: NormalizedToolCall[] = [];
    const usage: TokenUsage[] = [];
    for await (const ev of this.streamTurn(transcript, bundle, ctx)) {
      switch (ev.type) {
        case 'text_delta':
          text += ev.delta;
          emit({ type: 'text', delta: ev.delta });
          break;
        case 'tool_call_end':
          calls.push(ev.call);
          break;
        case 'finish':
          if (ev.usage) usage.push(ev.usage);
          break;
        default:
          break;
      }
    }
    return { text, calls, usage };
  }

  private async executeToolCall(
    call: NormalizedToolCall,
    bundle: PolicyBundle,
    ctx: ToolContext,
    opts: RunOptions,
    emit: (e: RawAgentEvent) => void,
  ): Promise<{ ok: boolean; output: string }> {
    const started = Date.now();

    const deny = (reason: string): { ok: boolean; output: string } => {
      const msg = `PERMISSION DENIED (${call.name}): ${reason}. Adapt and continue without it.`;
      emit({ type: 'tool_call', call, permitted: false });
      emit({
        type: 'tool_result',
        callId: call.id,
        tool: call.name,
        ok: false,
        durationMs: Date.now() - started,
        output: msg,
      });
      return { ok: false, output: msg };
    };

    const tool = this.registry.get(call.name);
    if (!tool || (bundle.toolAllowlist.length > 0 && !bundle.toolAllowlist.includes(call.name))) {
      return deny(`tool '${call.name}' is not available under this policy`);
    }

    const auth = await this.permissions.authorize(tool, call.arguments);
    if (!auth.allowed) return deny(auth.reason);

    emit({ type: 'tool_call', call, permitted: true });
    try {
      const result = await tool.execute(call.arguments, ctx);
      emit({
        type: 'tool_result',
        callId: call.id,
        tool: call.name,
        ok: result.ok,
        durationMs: Date.now() - started,
        output: truncate(result.output, EVENT_OUTPUT_PREVIEW_CHARS),
      });
      return { ok: result.ok, output: result.output };
    } catch (err) {
      if (isAbortError(err) || ctx.signal.aborted) throw err;
      const output = `tool crashed: ${err instanceof Error ? err.message : String(err)}`;
      emit({
        type: 'tool_result',
        callId: call.id,
        tool: call.name,
        ok: false,
        durationMs: Date.now() - started,
        output,
      });
      return { ok: false, output };
    }
  }
}
