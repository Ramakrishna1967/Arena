import type { ToolContext } from './types.js';
import { ArenaTool, requireString, toolOk } from './types.js';
import { truncate } from '../util.js';

const MAX_BODY_CHARS = 256 * 1024;

/**
 * Plain GET fetch with hard caps. No JS execution, no redirects across
 * protocols beyond what fetch itself allows. HTML is returned raw - the
 * model reads it fine; extraction pipelines come later if needed.
 */
export const webFetchTool: ArenaTool = {
  name: 'web_fetch',
  description: 'Fetch a URL over HTTP(S) and return status + body (truncated).',
  kind: 'web',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
  },
  execute: async (args, ctx) => {
    try {
      const url = requireString(args as Record<string, unknown>, 'url', 'web_fetch');
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, output: `web_fetch: unsupported protocol ${parsed.protocol}` };
      }
      const res = await ctx.fetchImpl(parsed, { signal: ctx.signal });
      const body = truncate(await res.text(), MAX_BODY_CHARS);
      const header = `${res.status} ${res.statusText || ''} ${res.headers.get('content-type') ?? ''}`.trim();
      return toolOk(`${header}\n\n${body}`, { status: res.status });
    } catch (e) {
      return { ok: false, output: `web_fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};
