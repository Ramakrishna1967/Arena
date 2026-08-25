import { spawn } from 'node:child_process';
import type { ToolContext } from './types.js';
import { ArenaTool, requireString, toolOk } from './types.js';
import { truncate } from '../util.js';

const MAX_OUTPUT_CHARS = 64 * 1024;

interface EvalOutcome {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

/**
 * Evaluates JavaScript in a FRESH node subprocess (no shared state, no
 * access back into this process). Code is piped via stdin to dodge Windows
 * command-line length limits. Network/shell access inside the eval is NOT
 * blocked - sandboxing hardening lands with L2 hardening / Phase 6.
 */
async function evalNode(code: string, signal: AbortSignal, timeoutMs: number): Promise<EvalOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=commonjs'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let timedOut = false;
    let settled = false;

    const kill = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* noop */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = (): void => kill();
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (c: Buffer | string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += String(c);
    });
    // stderr merged into stdout stream for simplicity of reporting
    child.stderr.on('data', (c: Buffer | string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += String(c);
    });

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve({ code: child.exitCode, stdout, timedOut });
    };

    child.on('error', finish);
    child.on('close', () => finish());

    child.stdin.write(code);
    child.stdin.end();
  });
}

export const codeEvalTool: ArenaTool = {
  name: 'code_eval',
  description: 'Run JavaScript (CommonJS) in a fresh node subprocess. Use console.log to emit results.',
  kind: 'code',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      timeout_ms: { type: 'number', description: 'Default 10000' },
    },
    required: ['code'],
  },
  execute: async (args, ctx) => {
    try {
      const a = args as Record<string, unknown>;
      const code = requireString(a, 'code', 'code_eval');
      const timeoutMs = typeof a.timeout_ms === 'number' ? Math.min(a.timeout_ms, 60_000) : 10_000;
      const r = await evalNode(code, ctx.signal, timeoutMs);
      if (r.timedOut) return { ok: false, output: `code_eval timed out after ${timeoutMs}ms` };
      const out = truncate(r.stdout.trim(), MAX_OUTPUT_CHARS);
      if (r.code === 0) return toolOk(out || '(no output)');
      return { ok: false, output: `eval exited ${r.code}\n${out}` };
    } catch (e) {
      return { ok: false, output: `code_eval failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};
