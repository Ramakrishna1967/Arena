import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ScoreRecord } from '../arbiter/types.js';

/** Arena on-disk layout - filesystem is the source of truth (no DB). */
export function ensureArenaRoot(arenaRoot: string): void {
  for (const sub of ['agents', 'skills', 'policy', 'runs', 'rubrics']) {
    const dir = path.join(arenaRoot, sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function agentDir(arenaRoot: string, profile: string): string {
  return path.join(arenaRoot, 'agents', profile);
}

export function skillsDir(arenaRoot: string): string {
  return path.join(arenaRoot, 'skills');
}

export function policyDir(arenaRoot: string): string {
  return path.join(arenaRoot, 'policy');
}

/**
 * Sub-agent outcomes count at HALF weight toward leveling (architecture
 * decision: levels belong to top-level identities; children contribute,
 * but cannot drive promotion as strongly as root work).
 */
export function weightForDepth(depth: number): number {
  return depth === 0 ? 1 : 0.5;
}

export function isPositiveVerdict(verdict: ScoreRecord['verdict']): boolean {
  return verdict === 'success';
}

const FINGERPRINT_MAX = 64;

/** Cheap deterministic task fingerprint: normalized text head + stable hash tail. */
export function fingerprintTask(task: string): string {
  const norm = task.toLowerCase().replace(/\s+/g, ' ').trim();
  let hash = 5381;
  for (let i = 0; i < norm.length; i++) {
    hash = ((hash << 5) + hash + norm.charCodeAt(i)) | 0;
  }
  const head = norm.slice(0, FINGERPRINT_MAX).replace(/[^a-z0-9 ]/g, '');
  return `${head}|${(hash >>> 0).toString(36)}`;
}
