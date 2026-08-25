import type { ToolSchema } from '../../providers/types.js';
import type { PolicyBundle } from '../types.js';
import type { ArenaTool } from './types.js';
import { codeEvalTool } from './code.js';
import { listDirTool, editFileTool, readFileTool, writeFileTool } from './files.js';
import { shellTool } from './shell.js';
import { taskCompleteTool } from './builtin.js';
import { webFetchTool } from './web.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ArenaTool>();

  register(tool: ArenaTool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ArenaTool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Effective tools under a bundle's allowlist (empty allowlist = all). */
  schemasFor(bundle: PolicyBundle): ToolSchema[] {
    const effective = [...this.tools.values()].filter(
      (t) => bundle.toolAllowlist.length === 0 || bundle.toolAllowlist.includes(t.name),
    );
    return effective.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
}

export function defaultRegistry(): ToolRegistry {
  // web_fetch reads its fetch impl from ToolContext per run - nothing to
  // bind at registration time.
  return new ToolRegistry()
    .register(shellTool)
    .register(readFileTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(listDirTool)
    .register(webFetchTool)
    .register(codeEvalTool)
    .register(taskCompleteTool);
}
