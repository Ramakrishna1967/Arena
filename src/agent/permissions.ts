import type { AskHandler, PermissionConfig, PermissionMode } from './types.js';
import type { ArenaTool, ToolContext } from './tools/types.js';

export interface Authorization {
  allowed: boolean;
  mode: PermissionMode;
  reason: string;
}

/**
 * Ordered rule evaluation: first match wins; fallback to config.default.
 * `ask` requires an interactive handler - without one we fail CLOSED
 * (deny) rather than silently allowing.
 */
export class PermissionManager {
  constructor(
    private readonly config: PermissionConfig,
    private readonly ask?: AskHandler,
  ) {}

  /** Extracts the matchable target per tool kind. */
  targetFor(tool: ArenaTool, args: Record<string, unknown>): string {
    switch (tool.kind) {
      case 'shell':
        return typeof args.command === 'string' ? args.command : '';
      case 'file':
        return typeof args.path === 'string' ? args.path : '';
      case 'web':
        return typeof args.url === 'string' ? args.url : '';
      default:
        return '';
    }
  }

  async authorize(tool: ArenaTool, args: Record<string, unknown>): Promise<Authorization> {
    const target = this.targetFor(tool, args);
    const matched = this.config.rules.find((r) => r.tool === tool.name && (!r.pattern || new RegExp(r.pattern).test(target)));
    const mode: PermissionMode = matched?.mode ?? this.config.default;

    if (mode === 'allow') return { allowed: true, mode, reason: matched?.pattern ? `allowed by rule '${matched.pattern}'` : 'allowed by default' };
    if (mode === 'deny') return { allowed: false, mode, reason: matched?.pattern ? `denied by rule '${matched.pattern}'` : 'denied by default' };

    // ask
    if (!this.ask) {
      // Decision path was 'ask'; outcome denied because nothing can ask.
      return { allowed: false, mode: 'ask', reason: 'permission ask required but no handler configured (fail closed)' };
    }
    const approved = await this.ask({ tool: tool.name, target, args });
    return approved
      ? { allowed: true, mode: 'ask', reason: 'approved interactively' }
      : { allowed: false, mode: 'ask', reason: 'denied interactively' };
  }
}
