import { spawn } from 'node:child_process';
import type { ToolContext } from './types.js';
import { ArenaTool, requireString, toolOk } from './types.js';
import { truncate } from '../util.js';
import { resolveInJail } from './files.js';

const MAX_OUTPUT_CHARS = 100 * 1024;

/**
 * Kills the whole process tree. On Windows, killing cmd.exe alone leaves
 * grandchildren alive holding our stdio pipes - which would hang 'close'
 * forever - so we escalate through taskkill /T /F instead.
 */
function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn(`taskkill /pid ${child.pid} /T /F`, { shell: true, windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* already dead */
  }
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a command through the OS shell. Output is capped; timeout and run
 * abort both kill the process. Known debt: on Windows killing cmd.exe does
 * not always kill grandchildren - acceptable until L2 hardening.
 */
async function runShell(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env: process.env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const kill = (): void => {
      killTree(child);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const onAbort = (): void => {
      kill();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer | string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += String(chunk);
    });

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else
        resolve({
          code: child.exitCode,
          stdout,
          stderr,
          timedOut,
        });
    };

    child.on('error', finish);
    child.on('close', () => finish());
  });
}

export const shellTool: ArenaTool = {
  name: 'run_command',
  description: 'Execute a shell command in the workspace (or a subdirectory of it). Returns exit code + output.',
  kind: 'shell',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string', description: 'Optional subdirectory of the workspace' },
      timeout_ms: { type: 'number', description: 'Default 30000' },
    },
    required: ['command'],
  },
  execute: async (args, ctx) => {
    const a = args as Record<string, unknown>;
    try {
      const command = requireString(a, 'command', 'run_command');
      let cwd = ctx.cwd;
      if (typeof a.cwd === 'string' && a.cwd.length > 0) {
        try {
          cwd = resolveInJail(ctx.cwd, a.cwd);
        } catch {
          return { ok: false, output: `cwd escapes workspace: ${a.cwd}` };
        }
      }
      const timeoutMs = typeof a.timeout_ms === 'number' ? a.timeout_ms : 30_000;
      const r = await runShell(command, cwd, ctx.signal, Math.min(timeoutMs, 120_000));

      if (r.timedOut) {
        return { ok: false, output: `command timed out after ${timeoutMs}ms\n${truncate(r.stdout + r.stderr, MAX_OUTPUT_CHARS)}` };
      }
      const out = truncate((r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).trim(), MAX_OUTPUT_CHARS);
      if (r.code === 0) return toolOk(out || '(no output)', { exitCode: 0 });
      return {
        ok: false,
        output: `exit code ${r.code}\n${out}`,
        data: { exitCode: r.code },
      };
    } catch (e) {
      return { ok: false, output: `run_command failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};
