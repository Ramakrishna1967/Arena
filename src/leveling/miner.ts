import { createProvider } from '../providers/registry.js';
import type { TrajectoryView } from '../recorder/trajectory.js';
import type { JudgeLaneConfig } from '../arbiter/llm-judge.js';
import type { SkillTriggers } from './types.js';

export interface MinedDraft {
  title: string;
  description: string;
  body: string;
  triggers: Partial<SkillTriggers>;
}

/**
 * Injectable mining boundary - like the judge lane, the LLM impl is just
 * the default. Mining runs OFFLINE (post-run, meta lane); it never touches
 * live sessions.
 */
export type MinerFn = (req: MinerRequest) => Promise<MinedDraft>;

export interface MinerRequest {
  task: string;
  trajectory: TrajectoryView;
  /** Final arbiter verdict for the run being mined. */
  verdict: 'success' | 'partial';
}

const MINER_SYSTEM_PROMPT = [
  'You distill successful agent trajectories into reusable SKILL.md playbooks.',
  'Extract what a FUTURE agent should do differently when facing a similar task.',
  'Prefer specific, checkable guidance over platitudes. Max ~200 words of body.',
  'Respond with STRICT JSON only:',
  '{"title":"...","description":"one line","triggers":{"keywords":["..."],"pathGlobs":[],"commandPrefixes":[]},"body":"markdown instructions"}',
].join('\n');

export function llmSkillMiner(cfg: JudgeLaneConfig): MinerFn {
  const adapter = createProvider(cfg.provider, { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs });
  return async (req) => {
    let text = '';
    for await (const ev of adapter.complete({
      model: cfg.model,
      stream: false,
      system: MINER_SYSTEM_PROMPT,
      messages: [{ role: 'user', text: renderMinerPrompt(req) }],
      temperature: cfg.temperature ?? 0,
      maxTokens: cfg.maxTokens ?? 800,
    })) {
      if (ev.type === 'text_delta') text += ev.delta;
    }
    const parsed = extractJsonLoose(text) as Record<string, unknown>;
    if (typeof parsed?.title !== 'string' || typeof parsed?.body !== 'string') {
      throw new Error('miner JSON missing title/body');
    }
    const rawTriggers = (parsed.triggers ?? {}) as Record<string, unknown>;
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return {
      title: parsed.title,
      description: typeof parsed.description === 'string' ? parsed.description : '',
      body: parsed.body,
      triggers: { keywords: arr(rawTriggers.keywords), pathGlobs: arr(rawTriggers.pathGlobs), commandPrefixes: arr(rawTriggers.commandPrefixes) },
    };
  };
}

export function renderMinerPrompt(req: MinerRequest): string {
  const t = req.trajectory;
  const steps = t.steps
    .map((s) => {
      const calls = s.calls.map((c) => `    - ${c.name} ${JSON.stringify(c.args)}`).join('\n');
      return `  step ${s.step}: ${s.text || '(no text)'}${calls ? `\n${calls}` : ''}`;
    })
    .join('\n');
  const results = t.toolResults.map((r) => `  - ${r.name} ok=${r.ok}: ${r.output.slice(0, 300)}`).join('\n');
  return [
    `TASK: ${req.task}`,
    `VERDICT: ${req.verdict}`,
    ``,
    `STEPS:`,
    steps || '  (none)',
    ``,
    `TOOL RESULTS:`,
    results || '  (none)',
    ``,
    `FINAL ANSWER: ${t.finalText ?? '(none)'}`,
  ].join('\n');
}

function extractJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    /* fall through */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* noop */
    }
  }
  throw new Error('miner returned no parseable JSON');
}
