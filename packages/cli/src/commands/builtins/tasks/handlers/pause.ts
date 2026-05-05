import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import type { AgentCiActionResult, Signaller } from '../agent-ci-control.js';
import { togglePauseAgentCiRun } from '../agent-ci-control.js';
import { resolveTask } from './_shared.js';

//#region Types

export interface PauseTaskArgs {
  readonly taskId: string;
  /** Optional injection seam for tests. */
  readonly signaller?: Signaller;
}

export interface PauseTaskResult {
  readonly outcome: AgentCiActionResult;
}

//#endregion

//#region Public API

/**
 * Pause the active agent-ci runner for a task. Idempotent against an
 * already-paused runner (the underlying control surface toggles, so a
 * caller wanting strict pause-only semantics should inspect
 * `outcome.kind` and call `unpauseTaskHandler` if `resumed`).
 */
export async function pauseTaskHandler(
  ctx: TaskStoreContext,
  args: PauseTaskArgs,
): Promise<PauseTaskResult> {
  await resolveTask(ctx, args.taskId);
  const outcome = await togglePauseAgentCiRun(ctx, args.taskId, args.signaller);
  return {
    outcome,
  };
}

//#endregion
