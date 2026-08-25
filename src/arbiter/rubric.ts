import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Rubric } from './types.js';

export const DEFAULT_RUBRIC_NAME = 'default';

/** Shipped baseline. Weights must sum to ~1; validation enforces it on load too. */
export const DEFAULT_RUBRIC: Rubric = {
  name: DEFAULT_RUBRIC_NAME,
  version: '1.0.0',
  description:
    'Balanced default rubric. Hard gates run first; the judge scores dimensions only when all hard checks pass.',
  dimensions: [
    { id: 'task_completion', description: 'Did the final state satisfy the requested task?', weight: 0.45 },
    { id: 'tool_use_quality', description: 'Correct, minimal, safe tool choices; sensible recovery from failures.', weight: 0.25 },
    { id: 'efficiency', description: 'Reasonable step/token cost for the work achieved.', weight: 0.15 },
    { id: 'clarity', description: 'Final answer communicates outcome clearly to the user.', weight: 0.15 },
  ],
  hardChecks: ['run_completed', 'tolerable_tool_failures'],
};

export function rubricsDir(arenaRoot: string): string {
  return path.join(arenaRoot, 'rubrics');
}

function validate(r: Rubric): void {
  if (!r.name || !r.version) throw new Error(`rubric missing name/version`);
  if (!Array.isArray(r.dimensions) || r.dimensions.length === 0) throw new Error(`rubric '${r.name}' has no dimensions`);
  const ids = new Set<string>();
  let weightSum = 0;
  for (const d of r.dimensions) {
    if (!d.id || ids.has(d.id)) throw new Error(`rubric '${r.name}': dimension id missing or duplicated ('${d.id}')`);
    ids.add(d.id);
    if (!(d.weight > 0)) throw new Error(`rubric '${r.name}': dimension '${d.id}' needs positive weight`);
    weightSum += d.weight;
  }
  if (Math.abs(weightSum - 1) > 0.01) throw new Error(`rubric '${r.name}': weights sum to ${weightSum}, expected ~1`);
  if (!Array.isArray(r.hardChecks)) throw new Error(`rubric '${r.name}': hardChecks must be an array`);
}

/** Writes the shipped default rubric into <arenaRoot>/rubrics if absent. */
export function ensureDefaultRubric(arenaRoot: string): string {
  const dir = rubricsDir(arenaRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${DEFAULT_RUBRIC_NAME}.json`);
  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(DEFAULT_RUBRIC, null, 2)}\n`, 'utf8');
  }
  return file;
}

export function loadRubric(arenaRoot: string, name: string): Rubric {
  const file = path.join(rubricsDir(arenaRoot), `${name}.json`);
  if (!existsSync(file)) {
    throw new Error(`rubric '${name}' not found at ${file}`);
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Rubric;
  validate(parsed);
  return parsed;
}
