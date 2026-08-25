import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codeEvalTool,
  editFileTool,
  listDirTool,
  readFileTool,
  shellTool,
  webFetchTool,
  writeFileTool,
} from '../../src/index.js';
import type { ToolContext } from '../../src/agent/tools/types.js';

const dirs: string[] = [];

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'arena-l2-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function ctxFor(cwd: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd, signal: new AbortController().signal, fetchImpl: (...a) => globalThis.fetch(...a), ...overrides };
}

describe('file tools', () => {
  it('write -> read -> list roundtrip inside the jail', async () => {
    const ws = await tempWorkspace();
    const ctx = ctxFor(ws);
    const w = await writeFileTool.execute({ path: 'src/note.txt', content: 'hello arena' }, ctx);
    expect(w.ok).toBe(true);

    const r = await readFileTool.execute({ path: 'src/note.txt' }, ctx);
    expect(r).toMatchObject({ ok: true, output: 'hello arena' });

    const ls = await listDirTool.execute({ path: '.' }, ctx);
    expect(ls.output).toContain('d src/');
  });

  it('rejects paths escaping the workspace jail', async () => {
    const ws = await tempWorkspace();
    const ctx = ctxFor(ws);
    for (const evil of ['../outside.txt', `${tmpdir()}/abs-escape.txt`, '..\\outside.txt']) {
      const r = await writeFileTool.execute({ path: evil, content: 'x' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('jail');
    }
  });

  it('edit_file enforces unique old_string', async () => {
    const ws = await tempWorkspace();
    const ctx = ctxFor(ws);
    await writeFileTool.execute({ path: 'f.txt', content: 'a a a' }, ctx);

    const ambiguous = await editFileTool.execute({ path: 'f.txt', old_string: 'a', new_string: 'b' }, ctx);
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.output).toContain('3 times');

    const missing = await editFileTool.execute({ path: 'f.txt', old_string: 'zzz', new_string: 'q' }, ctx);
    expect(missing.ok).toBe(false);

    const good = await editFileTool.execute(
      { path: 'f.txt', old_string: 'a a', new_string: 'c' },
      ctx,
    );
    expect(good.ok).toBe(true);
    expect(await readFile(path.join(ws, 'f.txt'), 'utf8')).toBe('c a');
  });
});

describe('shell tool', () => {
  it('captures stdout and exit codes (cross-platform via node)', async () => {
    const ws = await tempWorkspace();
    const ok = await shellTool.execute(
      { command: `node -e "console.log(41+1)"` },
      ctxFor(ws),
    );
    expect(ok).toMatchObject({ ok: true });
    expect(ok.output.trim()).toBe('42');

    const bad = await shellTool.execute(
      { command: `node -e "process.exit(3)"` },
      ctxFor(ws),
    );
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain('exit code 3');
  });

  it('enforces timeout by killing the process', async () => {
    const ws = await tempWorkspace();
    const r = await shellTool.execute(
      { command: `node -e "setTimeout(()=>{},60000)"`, timeout_ms: 500 },
      ctxFor(ws),
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain('timed out');
  }, 15000);

  it('jailed subdirectory cwd works; escaping cwd rejected', async () => {
    const ws = await tempWorkspace();
    await writeFileTool.execute({ path: 'sub/marker.txt', content: 'x' }, ctxFor(ws));
    const ok = await shellTool.execute(
      { command: `node -e "console.log(require('fs').existsSync('marker.txt'))"`, cwd: 'sub' },
      ctxFor(ws),
    );
    expect(ok.output.trim()).toBe('true');

    const evil = await shellTool.execute({ command: `node -e "console.log(1)"`, cwd: '../..' }, ctxFor(ws));
    expect(evil.ok).toBe(false);
    expect(evil.output).toContain('escapes workspace');
  });
});

describe('code_eval tool', () => {
  it('evaluates JS in a fresh subprocess', async () => {
    const r = await codeEvalTool.execute(
      { code: `const xs=[1,2,3]; console.log(xs.reduce((a,b)=>a+b,0))` },
      ctxFor(await tempWorkspace()),
    );
    expect(r.ok).toBe(true);
    expect(r.output.trim()).toBe('6');
  });

  it('reports runtime errors as failures with stderr content', async () => {
    const r = await codeEvalTool.execute({ code: `throw new Error('boom')` }, ctxFor(await tempWorkspace()));
    expect(r.ok).toBe(false);
    expect(r.output).toContain('boom');
  });

  it('times out infinite loops', async () => {
    const r = await codeEvalTool.execute(
      { code: `while(true){}`, timeout_ms: 400 },
      ctxFor(await tempWorkspace()),
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain('timed out');
  }, 10000);
});

describe('web_fetch tool', () => {
  it('uses injected fetch impl and reports status + body', async () => {
    const fake = (async () =>
      new Response('<html>arena docs</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch;
    const r = await webFetchTool.execute({ url: 'https://example.test/docs' }, ctxFor('.', { fetchImpl: fake }));
    expect(r.ok).toBe(true);
    expect(r.output).toContain('200');
    expect(r.output).toContain('arena docs');
  });

  it('rejects non-http protocols before fetching', async () => {
    let called = 0;
    const counting = (async () => {
      called += 1;
      return new Response('');
    }) as typeof fetch;
    const r = await webFetchTool.execute({ url: 'file:///etc/passwd' }, ctxFor('.', { fetchImpl: counting }));
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
  });
});
