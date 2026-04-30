import type { AgentCiActionResult, Signaller } from '../agent-ci-control.js';
import { togglePauseAgentCiRun } from '../agent-ci-control.js';
import type { TaskStoreContext } from '../fs-store.js';
import { resolveTask } from './_shared.js';

//#region Types

export interface UnpauseTaskArgs {
  readonly taskId: string;
  /** Optional injection seam for tests. */
  readonly signaller?: Signaller;
}

export interface UnpauseTaskResult {
  readonly outcome: AgentCiActionResult;
}

//#endregion

//#region Public API

/**
 * Resume a paused agent-ci runner. Wraps the underlying toggle so the
 * verb name reads naturally on the CLI; semantically a pause/unpause
 * pair is just two calls to `togglePauseAgentCiRun`.
 */
export async function unpauseTaskHandler(
  ctx: TaskStoreContext,
  args: UnpauseTaskArgs,
): Promise<UnpauseTaskResult> {
  await resolveTask(ctx, args.taskId);
  const outcome = await togglePauseAgentCiRun(ctx, args.taskId, args.signaller);
  return {
    outcome,
  };
}

//#endregion
