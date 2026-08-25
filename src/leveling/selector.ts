import type { SkillData } from './types.js';

export interface SelectionInput {
  /** Task text for keyword matching. */
  taskText: string;
  /** Optional context signals. */
  path?: string;
  command?: string;
  /** Prompt-token budget for injected skills. */
  tokenBudget: number;
  /** Deterministic 0..99 roll deciding canary exposure. */
  canaryRoll: number;
  canaryPercent: number;
}

export interface SelectedSkill {
  data: SkillData;
  body: string;
  matchScore: number;
}

/**
 * Runtime trigger matching - deterministic-first (architecture decision):
 *   score = keyword hits in task text
 *         + path glob hit (+2)
 *         + command prefix hit (+2)
 * Candidates ride along only on canary rolls (roll < canaryPercent), so a
 * new version earns evidence before full exposure WITHOUT any mid-session
 * behavior swap - selection happens at session start.
 */
export function selectSkills(
  skills: Array<{ data: SkillData; body: string }>,
  input: SelectionInput,
): SelectedSkill[] {
  const text = input.taskText.toLowerCase();
  const scored: Array<SelectedSkill & { status: string }> = [];

  for (const s of skills) {
    if (s.data.status !== 'active' && s.data.status !== 'candidate') continue;
    if (s.data.status === 'candidate' && input.canaryRoll >= input.canaryPercent) continue;

    let score = 0;
    for (const kw of s.data.triggers.keywords) {
      if (kw.length > 0 && text.includes(kw.toLowerCase())) score += 1;
    }
    if (input.path !== undefined && matchesGlob(input.path, s.data.triggers.pathGlobs)) score += 2;
    if (
      input.command !== undefined &&
      s.data.triggers.commandPrefixes.some((p) => p.length > 0 && input.command!.toLowerCase().startsWith(p.toLowerCase()))
    ) {
      score += 2;
    }
    // A skill with zero structural hits but a keyword-free trigger set is
    // treated as always-relevant background guidance at lowest priority.
    if (score === 0 && totalTriggers(s.data) === 0) score = 0.5;

    if (score > 0) scored.push({ data: s.data, body: s.body, matchScore: score, status: s.data.status });
  }

  scored.sort((a, b) => b.matchScore - a.matchScore || a.data.id.localeCompare(b.data.id));

  const picked: SelectedSkill[] = [];
  let budget = input.tokenBudget;
  for (const s of scored) {
    if (s.data.tokenCost <= budget) {
      picked.push({ data: s.data, body: s.body, matchScore: s.matchScore });
      budget -= s.data.tokenCost;
    }
  }
  return picked;
}

function totalTriggers(d: SkillData): number {
  return d.triggers.keywords.length + d.triggers.pathGlobs.length + d.triggers.commandPrefixes.length;
}

/** Tiny glob matcher supporting `**` and `*` segments only. */
export function matchesGlob(p: string, globs: string[]): boolean {
  return globs.some((g) => {
    const pattern = g
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\0DOUBLE\0')
      .replace(/\*/g, '[^/]*')
      .replace(/\0DOUBLE\0/g, '.*');
    return new RegExp(`^${pattern}$`).test(p.replace(/\\/g, '/'));
  });
}
