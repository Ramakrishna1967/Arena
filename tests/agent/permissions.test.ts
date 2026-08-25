import { describe, expect, it } from 'vitest';
import { PermissionManager } from '../../src/agent/permissions.js';
import { shellTool, writeFileTool } from '../../src/index.js';
import type { AskHandler } from '../../src/index.js';

const OPEN_CFG = { default: 'allow' as const, rules: [] };
const LOCKED_CFG = { default: 'deny' as const, rules: [] };

describe('permission manager', () => {
  it('default deny blocks everything without rules', async () => {
    const pm = new PermissionManager(LOCKED_CFG);
    const auth = await pm.authorize(shellTool, { command: 'echo hi' });
    expect(auth.allowed).toBe(false);
  });

  it('first matching rule wins over later ones', async () => {
    const pm = new PermissionManager({
      default: 'deny',
      rules: [
        { tool: 'run_command', mode: 'allow', pattern: '^git status' },
        { tool: 'run_command', mode: 'ask', pattern: '^git' },
      ],
    });
    expect((await pm.authorize(shellTool, { command: 'git status --short' })).allowed).toBe(true);
    const askResult = await pm.authorize(shellTool, { command: 'git push origin main' });
    expect(askResult.mode).toBe('ask');
    expect(askResult.allowed).toBe(false); // no handler -> fail closed
  });

  it('falls back to config default when nothing matches', async () => {
    const pm = new PermissionManager({ default: 'allow', rules: [{ tool: 'run_command', mode: 'deny', pattern: 'rm ' }] });
    expect((await pm.authorize(shellTool, { command: 'node --version' })).allowed).toBe(true);
    expect((await pm.authorize(shellTool, { command: 'rm -rf /' })).allowed).toBe(false);
  });

  it('ask consults the handler and honors its verdict', async () => {
    let asked = 0;
    const yesHandler: AskHandler = async () => {
      asked += 1;
      return true;
    };
    const pm = new PermissionManager({ default: 'ask', rules: [] }, yesHandler);
    expect((await pm.authorize(writeFileTool, { path: 'x.txt', content: '1' })).allowed).toBe(true);
    expect(asked).toBe(1);

    const noPm = new PermissionManager({ default: 'ask', rules: [] }, async () => false);
    const denied = await noPm.authorize(writeFileTool, { path: 'y.txt', content: '' });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('interactively');
  });

  it('targets are extracted per tool kind', () => {
    const pm = new PermissionManager(OPEN_CFG);
    expect(pm.targetFor(shellTool, { command: 'ls -la' })).toBe('ls -la');
    expect(pm.targetFor(writeFileTool, { path: 'src/a.ts' })).toBe('src/a.ts');
  });
});
