import type { SkillStore } from './skill-store.js';
import type { PolicyStore } from './policy.js';
import type { SkillLineage, SkillStatus } from './types.js';

/** Jaccard similarity above this blocks promotion as likely-contradictory. */
const CONTRADICTION_THRESHOLD = 0.6;

/**
 * Contradiction check at promotion time (architecture failure mode #2):
 * two active skills with heavily overlapping triggers will fight in every
 * matched session. Cheap deterministic proxy: keyword-set Jaccard vs every
 * currently-active skill version.
 */
export function findContradiction(
  store: SkillStore,
  policy: PolicyStore,
  candidateId: string,
): { conflictingWith: string; similarity: number } | undefined {
  const candidate = store.load(candidateId);
  if (!candidate) throw new Error(`skill '${candidateId}' not found`);
  const candKeys = new Set(candidate.data.triggers.keywords.map((k) => k.toLowerCase()));

  const pointer = policy.current();
  for (const [activeId] of Object.entries(pointer.activeSkillVersions)) {
    if (activeId === candidateId) continue;
    const other = store.load(activeId);
    if (!other || other.data.status !== 'active') continue;
    const otherKeys = new Set(other.data.triggers.keywords.map((k) => k.toLowerCase()));
    const sim = jaccard(candKeys, otherKeys);
    if (sim > CONTRADICTION_THRESHOLD) {
      return { conflictingWith: activeId, similarity: sim };
    }
  }
  return undefined;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface RollbackEvent {
  skillId: string;
  rolledBackVersion: string;
  restoredVersion?: string;
  observedRate: number;
  threshold: number;
  reason: string;
}

export interface RegressionOptions {
  minUses: number;
  windowCap: number;
  /** Never autodemote below this absolute rate even if global is lower. */
  floorRate: number;
  /** Allowed gap below the global baseline before rollback fires. */
  delta: number;
}

export const DEFAULT_REGRESSION: RegressionOptions = { minUses: 5, windowCap: 10, floorRate: 0.3, delta: 0.2 };

/**
 * Regression sweep - architecture failure mode #2 mitigation. For every
 * skill version currently ACTIVE under the policy pointer: if it has enough
 * credited uses AND its windowed success rate sits more than `delta` under
 * the global baseline (floored), AUTO-ROLLBACK: pointer flips to the parent
 * version (or removal), statuses flip, lineage keeps everything.
 */
export function regressionSweep(
  store: SkillStore,
  policy: PolicyStore,
  globalSuccessRate: number | null,
  opts: RegressionOptions = DEFAULT_REGRESSION,
): RollbackEvent[] {
  const pointer = policy.current();
  const events: RollbackEvent[] = [];

  // Baseline excluding nothing fancy: global agent rate, floored.
  const baseline = Math.max(globalSuccessRate ?? opts.floorRate, opts.floorRate);
  const threshold = Math.max(opts.floorRate, Math.round((baseline - opts.delta) * 100) / 100);

  for (const [skillId, version] of Object.entries(pointer.activeSkillVersions)) {
    const lineage: SkillLineage | undefined = store.loadLineage(skillId);
    const node = lineage?.versions[version];
    if (!node) continue;
    if (node.stats.window.length < opts.minUses) continue;
    const wins = node.stats.window.filter(Boolean).length;
    const rate = Math.round((wins / node.stats.window.length) * 100) / 100;
    if (rate >= threshold) continue;

    // POINTER FLIP: restore parent if it exists, otherwise drop entirely.
    const parent = node.parentVersion;
    if (parent !== undefined && lineage!.versions[parent]) {
      policy.flip((active) => {
        active[skillId] = parent;
      });
      store.setStatus(skillId, parent, 'active', `reactivated after rollback of ${version}`);
    } else {
      policy.flip((active) => {
        delete active[skillId];
      });
    }
    store.setStatus(skillId, version, 'rolled_back', `rate ${rate} < threshold ${threshold} over ${node.stats.window.length} uses`);
    events.push({
      skillId,
      rolledBackVersion: version,
      ...(parent !== undefined ? { restoredVersion: parent } : {}),
      observedRate: rate,
      threshold,
      reason: `windowed success ${rate} below ${threshold}`,
    });
  }
  return events;
}
