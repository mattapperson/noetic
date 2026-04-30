import type { TaskStoreContext } from '../fs-store.js';
import type { ActivateSliceResult } from '../hierarchy/activation.js';
import { activateSlice } from '../hierarchy/activation.js';
import { resolveTask } from './_shared.js';

//#region Types

export interface ActivateSliceHandlerArgs {
  readonly taskId: string;
  readonly sliceId: string;
  /**
   * If `triage` is omitted, the parent task's `autopilotEnabled` flag
   * picks the default — autopilot-on tasks triage every un-linked
   * feature in the slice; manual tasks just flip the slice's status.
   */
  readonly triage?: boolean;
}

export interface ActivateSliceHandlerResult {
  readonly outcome: ActivateSliceResult;
}

//#endregion

//#region Public API

/**
 * Mark a slice active. When the parent task has `autopilotEnabled`
 * (and the caller did not pass an explicit `triage` flag), every
 * un-linked feature in the slice is triaged into a placeholder leaf
 * task in the same call.
 */
export async function activateSliceHandler(
  ctx: TaskStoreContext,
  args: ActivateSliceHandlerArgs,
): Promise<ActivateSliceHandlerResult> {
  const task = await resolveTask(ctx, args.taskId);
  const triage = args.triage ?? task.autopilotEnabled;
  const outcome = await activateSlice(ctx, {
    parentTaskId: args.taskId,
    sliceId: args.sliceId,
    triage,
  });
  return {
    outcome,
  };
}

//#endregion
