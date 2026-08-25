import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomId } from '../agent/util.js';
import type { LedgerEntry, PolicyPointer } from './types.js';

/**
 * Policy generations: the ACTIVE skill-version set is a pointer file
 * (policy/current.json). Promotion/rollback = flip entries + append history.
 * Lineage truth lives in each skill's DAG; this is the fast runtime view.
 */
export class PolicyStore {
  constructor(private readonly policyRoot: string) {}

  private get currentPath(): string {
    return path.join(this.policyRoot, 'current.json');
  }
  private get historyPath(): string {
    return path.join(this.policyRoot, 'history.jsonl');
  }

  current(): PolicyPointer {
    if (!existsSync(this.currentPath)) {
      const fresh: PolicyPointer = { genId: randomId('gen'), updatedAt: new Date().toISOString(), activeSkillVersions: {} };
      this.writeCurrent(fresh);
      return fresh;
    }
    return JSON.parse(readFileSync(this.currentPath, 'utf8')) as PolicyPointer;
  }

  writeCurrent(p: PolicyPointer): void {
    if (!existsSync(this.policyRoot)) mkdirSync(this.policyRoot, { recursive: true });
    writeFileSync(this.currentPath, `${JSON.stringify(p, null, 2)}\n`, 'utf8');
  }

  /** Mutates the active map and bumps the generation id - the "pointer flip". */
  flip(mutate: (active: Record<string, string>) => void): PolicyPointer {
    const p = this.current();
    mutate(p.activeSkillVersions);
    p.genId = randomId('gen');
    p.updatedAt = new Date().toISOString();
    this.writeCurrent(p);
    this.appendHistory({ genId: p.genId, ts: p.updatedAt, activeSkillVersions: { ...p.activeSkillVersions } });
    return p;
  }

  private appendHistory(entry: unknown): void {
    if (!existsSync(this.policyRoot)) mkdirSync(this.policyRoot, { recursive: true });
    writeFileSync(this.historyPath, `${JSON.stringify(entry)}\n`, { flag: 'a' });
  }
}

/**
 * Injection ledger: which skill versions were placed into which runs.
 * Joining this with ScoreRecords is what gives per-skill credit/debit -
 * closing the measurement loop between selector and regression monitor.
 */
export class SkillLedger {
  constructor(private readonly filePath: string) {}

  record(runId: string, selections: Array<{ skillId: string; version: string }>): void {
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const lines = selections.map((s) =>
      JSON.stringify({
        runId,
        skillId: s.skillId,
        version: s.version,
        ts: new Date().toISOString(),
      } satisfies LedgerEntry),
    );
    if (lines.length === 0) return;
    writeFileSync(this.filePath, `${lines.join('\n')}\n`, { flag: 'a' });
  }

  all(): LedgerEntry[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as LedgerEntry);
  }
}
