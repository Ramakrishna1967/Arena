import { createProvider } from '../providers/registry.js';
import type { ProviderName } from '../providers/types.js';
import {
  JUDGE_SYSTEM_PROMPT,
  extractJson,
  renderJudgePrompt,
  type DimensionScore,
  type JudgeFn,
  type JudgeRequest,
} from './judge-types.js';

export interface JudgeLaneConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * The LLM meta-lane: a SEPARATE provider/model configuration from the
 * worker lane (architecture constraint - judge config independent of
 * worker config). Non-streaming, temperature 0 by default, strict-JSON
 * contract with brace-scan fallback extraction.
 */
export function llmJudge(cfg: JudgeLaneConfig): JudgeFn {
  const adapter = createProvider(cfg.provider, {
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    timeoutMs: cfg.timeoutMs,
  });

  return async (req: JudgeRequest) => {
    const events = [];
    let text = '';
    let usage;
    for await (const ev of adapter.complete({
      model: cfg.model,
      stream: false,
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', text: renderJudgePrompt(req) }],
      temperature: cfg.temperature ?? 0,
      maxTokens: cfg.maxTokens ?? 1024,
    })) {
      if (ev.type === 'text_delta') text += ev.delta;
      if (ev.type === 'finish' && ev.usage) usage = ev.usage;
      events.push(ev);
    }

    const parsed = extractJson(text) as {
      dimensions?: Record<string, { score?: unknown; rationale?: unknown }>;
      overallComment?: unknown;
    };
    if (!parsed?.dimensions || typeof parsed.dimensions !== 'object') {
      throw new Error('judge JSON missing "dimensions" object');
    }

    const dimensions: Record<string, DimensionScore> = {};
    for (const d of req.dimensions) {
      const raw = parsed.dimensions[d.id];
      const score = Number(raw?.score);
      dimensions[d.id] = {
        score: Number.isFinite(score) ? Math.min(10, Math.max(0, score)) : 0,
        rationale: typeof raw?.rationale === 'string' ? raw.rationale : '(judge gave no rationale)',
      };
    }
    return {
      dimensions,
      overallComment: typeof parsed.overallComment === 'string' ? parsed.overallComment : '',
      ...(usage !== undefined ? { usage } : {}),
    };
  };
}
