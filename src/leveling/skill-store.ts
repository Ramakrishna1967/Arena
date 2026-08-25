import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomId } from '../agent/util.js';
import type { SkillData, SkillLineage, SkillStatus, SkillTriggers } from './types.js';

function skillDir(skillsRoot: string, id: string): string {
  return path.join(skillsRoot, id);
}
function versionsDir(skillsRoot: string, id: string): string {
  return path.join(skillDir(skillsRoot, id), 'versions');
}

export function slugify(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${base || 'skill'}-${randomId('s').split('_')[2]}`;
}

/**
 * SkillStore - skills live as human-readable SKILL.md files with a canonical
 * machine-readable skill.json beside them (single source of truth), plus a
 * lineage.json DAG per skill: {version -> {parent, status, stats,...}}.
 *
 * Rollback is a pointer/status flip in this DAG - history is never rewritten.
 */
export class SkillStore {
  constructor(private readonly skillsRoot: string) {}

  /** Creates a new skill at v1 (status draft). Returns the full data + lineage. */
  create(input: {
    title: string;
    description: string;
    body: string;
    triggers?: Partial<SkillTriggers>;
    minedFromRunId?: string;
    id?: string;
  }): { data: SkillData; lineage: SkillLineage; files: { dir: string; md: string; json: string; versionMd: string } } {
    const id = input.id ?? slugify(input.title);
    const now = new Date().toISOString();
    const data: SkillData = {
      id,
      version: 'v1',
      status: 'draft',
      title: input.title,
      description: input.description,
      triggers: {
        keywords: input.triggers?.keywords ?? [],
        pathGlobs: input.triggers?.pathGlobs ?? [],
        commandPrefixes: input.triggers?.commandPrefixes ?? [],
      },
      tokenCost: estimateTokens(input.body),
      created: now,
      ...(input.minedFromRunId !== undefined ? { minedFromRunId: input.minedFromRunId } : {}),
    };
    const lineage: SkillLineage = {
      id,
      versions: {
        v1: {
          version: 'v1',
          status: 'draft',
          createdAt: now,
          ...(input.minedFromRunId !== undefined ? { minedFromRunId: input.minedFromRunId } : {}),
          stats: { uses: 0, successes: 0, window: [] },
        },
      },
      tip: 'v1',
    };
    const files = this.writeAll(data, input.body);
    this.saveLineage(lineage);
    return { data, lineage, files };
  }

  exists(id: string): boolean {
    return existsSync(path.join(skillDir(this.skillsRoot, id), 'skill.json'));
  }

  load(id: string): { data: SkillData; body: string } | undefined {
    const jsonPath = path.join(skillDir(this.skillsRoot, id), 'skill.json');
    if (!existsSync(jsonPath)) return undefined;
    const data = JSON.parse(readFileSync(jsonPath, 'utf8')) as SkillData;
    const mdPath = path.join(versionsDir(this.skillsRoot, id), `${data.version}.md`);
    const body = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '';
    return { data, body };
  }

  listIds(): string[] {
    if (!existsSync(this.skillsRoot)) return [];
    return readdirSync(this.skillsRoot).filter((name) => this.exists(name));
  }

  loadLineage(id: string): SkillLineage | undefined {
    const p = path.join(skillDir(this.skillsRoot, id), 'lineage.json');
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as SkillLineage) : undefined;
  }

  saveLineage(lineage: SkillLineage): void {
    const dir = skillDir(this.skillsRoot, lineage.id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'lineage.json'), `${JSON.stringify(lineage, null, 2)}\n`, 'utf8');
  }

  /**
   * Derives the next version from `parentId` (DAG edge), copying content and
   * bumping status. Used for edits AND for rollback reactivations.
   */
  deriveVersion(
    id: string,
    parentId: string,
    patch: Partial<SkillData>,
    newBody: string | undefined,
    meta: { status: SkillStatus; reason?: string },
  ): { data: SkillData; version: string } {
    const current = this.load(id);
    if (!current) throw new Error(`skill '${id}' does not exist`);
    const lineage = this.loadLineage(id);
    if (!lineage) throw new Error(`skill '${id}' has no lineage`);

    // Next ordinal that does not collide: vN child of parentId.
    let n = Object.keys(lineage.versions).length + 1;
    let version = `v${n}`;
    while (lineage.versions[version] !== undefined) {
      n += 1;
      version = `v${n}`;
    }

    const data: SkillData = {
      ...current.data,
      ...patch,
      id,
      version,
      parentVersion: parentId,
      tokenCost: patch.tokenCost ?? estimateTokens(newBody ?? current.body),
    };

    const body = newBody ?? current.body;
    this.writeAll(data, body);
    lineage.versions[version] = {
      version,
      parentVersion: parentId,
      status: meta.status,
      createdAt: new Date().toISOString(),
      ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
      stats: { uses: 0, successes: 0, window: [] },
    };
    lineage.tip = version;
    this.saveLineage(lineage);
    return { data, version };
  }

  setStatus(id: string, version: string, status: SkillStatus, reason?: string): void {
    const lineage = this.loadLineage(id);
    if (!lineage?.versions[version]) throw new Error(`skill '${id}' version '${version}' not found`);
    lineage.versions[version].status = status;
    if (reason !== undefined) lineage.versions[version].reason = reason;
    this.saveLineage(lineage);

    // Point the canonical pointer at whichever version now holds the status.
    if (status === 'active' || status === 'candidate' || status === 'rolled_back' || status === 'retired') {
      const current = this.load(id)!;
      const updated: SkillData = { ...current.data, status };
      this.writeAll(updated, current.body);
    }
  }

  creditUse(id: string, version: string, success: boolean, windowCap = 10): void {
    const lineage = this.loadLineage(id);
    const node = lineage?.versions[version];
    if (!node) return;
    node.stats.uses += 1;
    if (success) node.stats.successes += 1;
    node.stats.window.push(success);
    while (node.stats.window.length > windowCap) node.stats.window.shift();
    this.saveLineage(lineage!);
  }

  deleteSkill(id: string): void {
    rmSync(skillDir(this.skillsRoot, id), { recursive: true, force: true });
  }

  private writeAll(data: SkillData, body: string): { dir: string; md: string; json: string; versionMd: string } {
    const dir = skillDir(this.skillsRoot, data.id);
    const vdir = versionsDir(this.skillsRoot, data.id);
    if (!existsSync(vdir)) mkdirSync(vdir, { recursive: true });

    const jsonPath = path.join(dir, 'skill.json');
    writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

    const mdPath = path.join(dir, 'SKILL.md');
    writeFileSync(mdPath, renderSkillMd(data, body), 'utf8');

    const versionMd = path.join(vdir, `${data.version}.md`);
    writeFileSync(versionMd, body, 'utf8');
    return { dir, md: mdPath, json: jsonPath, versionMd };
  }
}

/** ~4 chars/token heuristic - deterministic, no tokenizer dependency. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function renderSkillMd(d: SkillData, body: string): string {
  const y = (arr: string[]): string => (arr.length === 0 ? '[]' : `[${arr.map((s) => JSON.stringify(s)).join(', ')}]`);
  return [
    '---',
    `id: ${d.id}`,
    `version: ${d.version}`,
    ...(d.parentVersion !== undefined ? [`parentVersion: ${d.parentVersion}`] : []),
    `status: ${d.status}`,
    `title: ${JSON.stringify(d.title)}`,
    `description: ${JSON.stringify(d.description)}`,
    'triggers:',
    `  keywords: ${y(d.triggers.keywords)}`,
    `  pathGlobs: ${y(d.triggers.pathGlobs)}`,
    `  commandPrefixes: ${y(d.triggers.commandPrefixes)}`,
    `tokenCost: ${d.tokenCost}`,
    `created: ${d.created}`,
    ...(d.minedFromRunId !== undefined ? [`minedFromRunId: ${d.minedFromRunId}`] : []),
    '---',
    '',
    body,
    '',
  ].join('\n');
}
