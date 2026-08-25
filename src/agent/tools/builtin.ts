import type { ArenaTool } from './types.js';
import { toolOk } from './types.js';

/**
 * Explicit completion signal. The Executor treats calls to this tool as
 * terminal: it executes trivially, then ends the run with the summary as
 * finalText. Useful when a model would otherwise ramble past done.
 */
export const taskCompleteTool: ArenaTool = {
  name: 'task_complete',
  description: 'Call when the task is fully finished. Provide a short summary for the user.',
  kind: 'builtin',
  parameters: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  },
  execute: async (args) => {
    const summary = typeof (args as any).summary === 'string' ? (args as any).summary : '';
    return toolOk(summary || 'task complete');
  },
};
