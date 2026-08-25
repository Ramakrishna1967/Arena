import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolResult } from './types.js';
import { ArenaTool, requireString, toolError, toolOk } from './types.js';
import { truncate } from '../util.js';

const MAX_FILE_CHARS = 256 * 1024;

/**
 * All file tools are jailed to ctx.cwd by default - relative AND absolute
 * paths must resolve inside the workspace. This is the sharp edge that keeps
 * a confused model from touching ~/.ssh.
 */
export function resolveInJail(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace jail: ${p}`);
  }
  return abs;
}

function guard(ctx: ToolContext, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  void ctx;
  return fn().catch((e: unknown) =>
    toolError(e instanceof Error ? e.message : String(e)),
  );
}

export const readFileTool: ArenaTool = {
  name: 'read_file',
  description: 'Read a UTF-8 text file inside the workspace.',
  kind: 'file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path relative to workspace root' } },
    required: ['path'],
  },
  execute: (args, ctx) =>
    guard(ctx, async () => {
      const p = resolveInJail(ctx.cwd, requireString(args as Record<string, unknown>, 'path', 'read_file'));
      const content = await fs.readFile(p, 'utf8');
      return toolOk(truncate(content, MAX_FILE_CHARS));
    }),
};

export const writeFileTool: ArenaTool = {
  name: 'write_file',
  description: 'Create or overwrite a text file inside the workspace. Parent dirs are created.',
  kind: 'file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  execute: (args, ctx) =>
    guard(ctx, async () => {
      const a = args as Record<string, unknown>;
      const p = resolveInJail(ctx.cwd, requireString(a, 'path', 'write_file'));
      const content = typeof a.content === 'string' ? a.content : '';
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, content, 'utf8');
      return toolOk(`wrote ${Buffer.byteLength(content)} bytes to ${p}`);
    }),
};

export const editFileTool: ArenaTool = {
  name: 'edit_file',
  description:
    'Replace an exact substring in a file. The old_string must occur EXACTLY once, otherwise the edit is rejected.',
  kind: 'file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  execute: (args, ctx) =>
    guard(ctx, async () => {
      const a = args as Record<string, unknown>;
      const p = resolveInJail(ctx.cwd, requireString(a, 'path', 'edit_file'));
      const oldStr = requireString(a, 'old_string', 'edit_file');
      const newStr = requireString(a, 'new_string', 'edit_file');
      const content = await fs.readFile(p, 'utf8');
      const occurrences = content.split(oldStr).length - 1;
      if (occurrences === 0) return toolError(`edit_file: old_string not found in ${p}`);
      if (occurrences > 1) return toolError(`edit_file: old_string occurs ${occurrences} times in ${p}; provide more context`);
      await fs.writeFile(p, content.replace(oldStr, newStr), 'utf8');
      return toolOk(`edited ${p}`);
    }),
};

export const listDirTool: ArenaTool = {
  name: 'list_dir',
  description: 'List directory entries inside the workspace.',
  kind: 'file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Defaults to workspace root' } },
  },
  execute: (args, ctx) =>
    guard(ctx, async () => {
      const raw = typeof (args as any).path === 'string' ? (args as any).path : '.';
      const p = resolveInJail(ctx.cwd, raw);
      const entries = await fs.readdir(p, { withFileTypes: true });
      const lines = entries
        .slice(0, 500)
        .map((e) => `${e.isDirectory() ? 'd' : '-' } ${e.name}${e.isDirectory() ? '/' : ''}`);
      const suffix = entries.length > 500 ? `\n...[${entries.length - 500} more]` : '';
      return toolOk(lines.join('\n') + suffix);
    }),
};
