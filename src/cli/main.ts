#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeAtomic, withArenaLock } from '../persistence/atomic.js';
import { ArenaApp, renderSkillBlock, type ArenaAppConfig } from '../app.js';
import { DEFAULT_RUBRIC_NAME } from '../arbiter/rubric.js';
import type { JudgeLaneConfig } from '../arbiter/llm-judge.js';

export interface CliFlags {
  provider?: string;
  model?: string;
  profile?: string;
  cwd?: string;
  arenaRoot?: string;
  depth?: number;
  judgeProvider?: string;
  judgeModel?: string;
  json?: boolean;
}

/** Minimal zero-dependency argv parser: `cmd [positional...] --flag value`. */
export function parseArgs(argv: string[]): { command?: string; positionals: string[]; flags: CliFlags } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else if (command === undefined) {
      command = a;
    } else {
      positionals.push(a);
    }
  }
  return { command, positionals, flags: flags as CliFlags };
}

function requireFlag(flags: CliFlags, key: 'provider' | 'model'): void {
  if (!flags[key]) throw new Error(`--${key} is required (e.g. --provider openai --model gpt-4o)`);
}

export function buildApp(flags: CliFlags): ArenaApp {
  const cfg: ArenaAppConfig = {
    ...(flags.arenaRoot !== undefined ? { arenaRoot: flags.arenaRoot } : {}),
    ...(flags.profile !== undefined ? { profile: flags.profile } : {}),
    worker: {
      provider: (flags.provider ?? envProviderDefault()) as never,
      model: flags.model ?? defaultModel(flags.provider),
      apiKey: process.env[`${(flags.provider ?? 'openai').toUpperCase()}_API_KEY`],
    },
    ...(flags.depth !== undefined ? { maxDepth: flags.depth } : {}),
  };
  if (flags.judgeProvider && flags.judgeModel) {
    const lane: JudgeLaneConfig = {
      provider: flags.judgeProvider as never,
      model: flags.judgeModel,
      apiKey: process.env[`${flags.judgeProvider.toUpperCase()}_API_KEY`],
    };
    cfg.judgeLane = lane;
  }
  return new ArenaApp(cfg);
}

function envProviderDefault(): string {
  return 'openai';
}
function defaultModel(provider?: string): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-sonnet-4-20250514';
    case 'xai':
      return 'grok-3';
    case 'deepseek':
      return 'deepseek-chat';
    default:
      return 'gpt-4o';
  }
}

/**
 * Command dispatch. Returns process exit code. Rendering is deliberately
 * plain stdout - an ink-based renderer can replace `print()` later without
 * touching the app layer.
 */
export async function runCli(argv: string[], print: (s: string) => void = console.log): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);

  try {
    switch (command) {
      case 'init': {
        const app = buildApp({ ...flags, provider: flags.provider ?? 'openai', model: flags.model ?? 'gpt-4o' });
        await withArenaLock(app.arenaRoot, async () => {
          writeAtomic(path.join(app.arenaRoot, 'config.json'), `${JSON.stringify({ defaultRubric: DEFAULT_RUBRIC_NAME, profile: flags.profile ?? 'default', note: 'edit freely; CLI merges flags over this' }, null, 2)}\n`);
        });
        print(`arena initialized at ${app.arenaRoot}`);
        print(`set PROVIDER keys in env: OPENAI_API_KEY / ANTHROPIC_API_KEY / XAI_API_KEY / DEEPSEEK_API_KEY`);
        return 0;
      }

      case 'run': {
        requireFlag(flags, 'model');
        const task = positionals.join(' ');
        if (task.trim() === '') throw new Error('usage: arena run "your task"');
        const app = buildApp(flags);
        const outcome = await app.runTask(task, {
          ...(flags.cwd !== undefined ? { cwd: flags.cwd } : {}),
          onEvent: (e) => {
            if (e.type === 'text' && e.depth === 0) process.stderr.write(e.delta);
            else if (e.type === 'tool_call') process.stderr.write(`\n[tool] ${e.call.name} ${JSON.stringify(e.call.arguments).slice(0, 120)}\n`);
          },
        });
        process.stderr.write('\n');
        print(`run ${outcome.runId} -> ${outcome.result.status} (${outcome.record.verdict}, level gate: ${outcome.decision.promote ? 'PROMOTED' : decisionText(outcome.decision.reason)})`);
        if (outcome.injected.length > 0) print(`skills injected: ${outcome.injected.map((s) => `${s.id}@${s.version}`).join(', ')}`);
        return outcome.result.status === 'completed' ? 0 : 1;
      }

      case 'resume': {
        requireFlag(flags, 'model');
        const [runDir, ...rest] = positionals;
        if (!runDir || rest.length === 0) throw new Error('usage: arena resume <runDir> "follow-up instruction"');
        const app = buildApp(flags);
        const outcome = await app.resumeRun(runDir, rest.join(' '), {});
        print(`resumed -> run ${outcome.runId} ${outcome.result.status}\n${outcome.result.finalText ?? ''}`);
        return outcome.result.status === 'completed' ? 0 : 1;
      }

      case 'status': {
        const app = buildApp(flags);
        const s = app.status();
        print(`profile=${flags.profile ?? 'default'} level=${s.level} rolling_rate=${s.rollingRate ?? 'n/a'}`);
        print(`totals=${JSON.stringify(s.totals)}`);
        const active = Object.entries(s.activeSkills);
        print(active.length === 0 ? 'active skills: (none)' : `active skills:\n${active.map(([id, v]) => `  - ${id}@${v}`).join('\n')}`);
        return 0;
      }

      case 'runs': {
        const app = buildApp(flags);
        const runs = app.listRuns();
        print(runs.length === 0 ? 'no runs yet' : runs.map((r) => `${r.runId}  ${r.status ?? '?'}  ${r.startedAt ?? ''}`).join('\n'));
        return 0;
      }

      case 'skills': {
        const app = buildApp(flags);
        const sub = positionals[0] ?? 'list';
        if (sub === 'list') {
          const ids = app.engine.store.listIds();
          print(ids.length === 0 ? 'no skills' : ids.map((id) => `  - ${id} (${app.engine.store.load(id)?.data.status})`).join('\n'));
          return 0;
        }
        const id = positionals[1];
        if (id === undefined) throw new Error(`usage: arena skills ${sub} <skillId>`);
        if (sub === 'show') {
          const loaded = app.engine.store.load(id);
          if (!loaded) throw new Error(`unknown skill '${id}'`);
          print(renderSkillBlock('', [{ data: loaded.data, body: loaded.body, matchScore: 0 }]).trim());
          return 0;
        }
        if (sub === 'promote') {
          const cand = await withArenaLock(app.arenaRoot, async () => app.engine.promoteToCandidate(id));
          if (!cand.ok) {
            print(`blocked: ${cand.reason}`);
            return 1;
          }
          app.engine.promoteToActive(id);
          print(`${id} promoted to active under gen ${app.engine.policy.current().genId}`);
          return 0;
        }
        if (sub === 'retire') {
          await withArenaLock(app.arenaRoot, async () => {
            const data = app.engine.store.load(id)!.data;
            app.engine.policy.flip((active) => {
              delete active[id];
            });
            app.engine.store.setStatus(id, data.version, 'retired', 'manual retire');
          });
          print(`${id} retired`);
          return 0;
        }
        throw new Error(`unknown skills subcommand '${sub}' (list|show|promote|retire)`);
      }

      case 'why': {
        const [runDir] = positionals;
        if (!runDir) throw new Error('usage: arena why <runDir>');
        const app = buildApp(flags);
        const scoresDir = path.join(runDir, 'scores');
        const files = existsSync(scoresDir) ? readdirSync(scoresDir) : [];
        if (files.length === 0) throw new Error('no scores recorded for that run');
        for (const f of files) {
          const record = JSON.parse(readFileSync(path.join(scoresDir, f), 'utf8'));
          print(JSON.stringify(record, null, 2));
        }
        return 0;
      }

      case undefined:
      case 'help':
        print(USAGE);
        return command === undefined ? 1 : 0;

      default:
        throw new Error(`unknown command '${command}'\n\n${USAGE}`);
    }
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

function decisionText(reason: string): string {
  return reason.length > 60 ? `${reason.slice(0, 57)}...` : reason;
}

const USAGE = [
  'arena - multi-provider agent CLI where agents level up',
  '',
  'commands:',
  '  init                                  create ~/.arena layout + config',
  '  run "task"       [--provider p --model m --cwd dir]   run an agent task',
  '  resume <runDir> "follow-up"           cold-start continue from JSONL',
  '  status                                level + stats + active skills',
  '  runs                                  list recent runs',
  '  skills list|show|promote|retire       inspect and manage mined skills',
  '  why <runDir>                          show arbiter ScoreRecord(s)',
].join('\n');

// Bootstrap when executed directly (`arena ...` / `node dist/cli/main.js ...`);
// importing this module stays side-effect free for tests.
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  void runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
