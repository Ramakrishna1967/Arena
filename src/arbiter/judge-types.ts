import type { TokenUsage } from '../providers/types.js';
import type { RubricDimension } from './types.js';
import type { TrajectoryView } from '../recorder/trajectory.js';

export interface JudgeRequest {
  task: string;
  dimensions: RubricDimension[];
  trajectory: TrajectoryView;
}

export interface DimensionScore {
  score: number; // 0..10
  rationale: string;
}

export interface JudgeResult {
  dimensions: Record<string, DimensionScore>;
  overallComment: string;
  usage?: TokenUsage;
}

/** Injectable judge boundary: the LLM meta-lane is just the default impl. */
export type JudgeFn = (req: JudgeRequest) => Promise<JudgeResult>;

export const JUDGE_SYSTEM_PROMPT = [
  'You are a strict, skeptical evaluator of AI agent trajectories.',
  'Score ONLY what is evidenced in the trajectory; do not give benefit of the doubt.',
  'Respond with STRICT JSON and nothing else, shaped exactly like:',
  '{"dimensions":{"<dimension_id>":{"score":<0-10>,"rationale":"..."}},"overallComment":"..."}',
  'Every dimension id provided MUST appear in your output.',
].join('\n');

export function renderJudgePrompt(req: JudgeRequest): string {
  const t = req.trajectory;
  const steps = t.steps
    .map((s) => {
      const calls = s.calls
        .map((c) => `    - tool ${c.name} args=${JSON.stringify(c.args)}`)
        .join('\n');
      return `  step ${s.step}:\n    assistant: ${s.text || '(no text)'}${calls ? `\n${calls}` : ''}`;
    })
    .join('\n');
  const results = t.toolResults
    .map((r) => `  - ${r.name}(${r.callId}) ok=${r.ok}\n    output: ${r.output.slice(0, 600)}`)
    .join('\n');
  const dims = req.dimensions
    .map((d) => `  - ${d.id} (weight ${d.weight}): ${d.description}`)
    .join('\n');

  return [
    `TASK: ${t.task}`,
    ``,
    `RUBRIC DIMENSIONS (score each 0-10):`,
    dims,
    ``,
    `TRAJECTORY (status=${t.finalStatus ?? 'unfinished'}${t.errorMessage ? `, error=${t.errorMessage}` : ''}):`,
    steps,
    ``,
    `TOOL RESULTS:`,
    results || '  (none)',
    ``,
    `FINAL ANSWER: ${t.finalText ?? '(none)'}`,
    ``,
    `Return the JSON verdict now.`,
  ].join('\n');
}

/** Extracts the first balanced JSON object from arbitrary model text. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to brace scan */
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* unparseable */
    }
  }
  throw new Error('judge returned no parseable JSON');
}
