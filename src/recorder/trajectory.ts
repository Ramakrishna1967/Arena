import type { AgentEvent, RunStatus } from '../agent/types.js';

export interface TrajectoryStep {
  step: number;
  text: string;
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

/** Per-run view reconstructed purely from events - what hard checks and the judge see. */
export interface TrajectoryView {
  runId: string;
  depth: number;
  task: string;
  steps: TrajectoryStep[];
  toolResults: Array<{ callId: string; name: string; ok: boolean; output: string }>;
  finalStatus?: RunStatus;
  finalText?: string;
  errorMessage?: string;
}

export interface TreeNode {
  runId: string;
  parentId?: string;
  depth: number;
  task?: string;
  status?: RunStatus;
  finalText?: string;
}

export function treeNodes(events: AgentEvent[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const e of events) {
    let n = nodes.get(e.runId);
    if (!n) {
      n = { runId: e.runId, depth: e.depth, ...(e.parentId !== undefined ? { parentId: e.parentId } : {}) };
      nodes.set(e.runId, n);
    }
    if (e.type === 'run_start') n.task = e.task;
    if (e.type === 'run_end') {
      n.status = e.status;
      n.finalText = e.finalText;
    }
  }
  return [...nodes.values()];
}

/**
 * Rebuilds ONE node's trajectory from the flat stream. Children appear in
 * the parent's view only through their spawn_agent tool results - which is
 * exactly what the parent model observed too.
 */
export function buildTrajectoryView(events: AgentEvent[], runId: string): TrajectoryView {
  const own = events.filter((e) => e.runId === runId);
  const start = own.find((e): e is Extract<AgentEvent, { type: 'run_start' }> => e.type === 'run_start');
  if (!start) throw new Error(`no run_start for runId '${runId}'`);

  const view: TrajectoryView = {
    runId,
    depth: start.depth,
    task: start.task,
    steps: [],
    toolResults: [],
  };

  let current: TrajectoryStep | undefined;
  for (const e of own) {
    switch (e.type) {
      case 'step_start':
        current = { step: e.step, text: '', calls: [] };
        view.steps.push(current);
        break;
      case 'text':
        if (current) current.text += e.delta;
        break;
      case 'tool_call':
        current?.calls.push({ id: e.call.id, name: e.call.name, args: e.call.arguments });
        break;
      case 'tool_result':
        view.toolResults.push({ callId: e.callId, name: e.tool, ok: e.ok, output: e.output });
        break;
      case 'run_end':
        view.finalStatus = e.status;
        view.finalText = e.finalText;
        view.errorMessage = e.errorMessage;
        break;
      default:
        break;
    }
  }
  return view;
}
