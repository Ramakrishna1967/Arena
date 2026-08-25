import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, RunStatus } from '../agent/types.js';

export interface RunMeta {
  rootRunId?: string;
  startedAt?: string;
  endedAt?: string;
  status?: RunStatus;
}

/**
 * Append-only JSONL recorder (architecture decision: filesystem is the
 * source of truth; no DB). One directory per ROOT run:
 *
 *   <runDir>/events.jsonl   flat stream - root AND children interleaved,
 *                           every line self-describing via event meta
 *   <runDir>/meta.json      wall-clock summary written at finalize
 *   <runDir>/scores/        ScoreRecords land here (written by the Arbiter)
 *
 * The sink() wrapper is a passthrough: it never mutates or filters events,
 * so attaching the recorder cannot change execution behavior.
 */
export class Recorder {
  private firstTs?: string;
  private lastTs?: string;
  private rootRunId?: string;
  private status?: RunStatus;

  constructor(readonly runDir: string) {
    mkdirSync(runDir, { recursive: true });
  }

  get eventsPath(): string {
    return path.join(this.runDir, 'events.jsonl');
  }

  /** Passthrough event handler for RunOptions.onEvent. */
  sink(): (e: AgentEvent) => void {
    return (e: AgentEvent) => this.write(e);
  }

  write(e: AgentEvent): void {
    const now = new Date().toISOString();
    this.firstTs ??= now;
    if (e.type === 'run_start' && e.depth === 0) this.rootRunId ??= e.runId;
    if (e.type === 'run_end' && e.depth === 0) this.status = e.status;
    this.lastTs = now;
    appendFileSync(this.eventsPath, `${JSON.stringify(e)}\n`, 'utf8');
  }

  finalize(): RunMeta {
    const meta: RunMeta = {
      ...(this.rootRunId !== undefined ? { rootRunId: this.rootRunId } : {}),
      ...(this.firstTs !== undefined ? { startedAt: this.firstTs } : {}),
      ...(this.lastTs !== undefined ? { endedAt: this.lastTs } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
    };
    writeFileSync(path.join(this.runDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    return meta;
  }

  /** Scores directory (created lazily by the Arbiter). */
  scoresDir(): string {
    const d = path.join(this.runDir, 'scores');
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return d;
  }
}

/** Parses an events.jsonl back into typed events. Throws with line numbers on corruption. */
export function loadEvents(input: string | AgentEvent[]): AgentEvent[] {
  if (Array.isArray(input)) return input;
  const file = input.endsWith('events.jsonl') ? input : path.join(input, 'events.jsonl');
  const raw = readFileSync(file, 'utf8');
  const events: AgentEvent[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      events.push(JSON.parse(line) as AgentEvent);
    } catch (err) {
      throw new Error(`corrupted events.jsonl at line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return events;
}
