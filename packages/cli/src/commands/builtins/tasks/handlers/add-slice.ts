import { EventKind } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { appendEvent } from '@noetic/code-agent/tasks/store/fs-node';
import type { Slice } from '../hierarchy/schemas.js';
import { generateSliceId, SliceStatus } from '../hierarchy/schemas.js';
import { listSlices, loadMilestone, saveSlice } from '../hierarchy/store.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface AddSliceArgs {
  readonly taskId: string;
  readonly milestoneId: string;
  readonly title: string;
  readonly verification: string;
  readonly description?: string;
}

export interface AddSliceResult {
  readonly slice: Slice;
}

//#endregion

//#region Public API

/**
 * Append a slice under an existing milestone. Order index is the
 * count of sibling slices on the same milestone, so callers don't need
 * to compute it themselves.
 */
export async function addSliceHandler(
  ctx: TaskStoreContext,
  args: AddSliceArgs,
): Promise<AddSliceResult> {
  await resolveTask(ctx, args.taskId);
  const milestone = await loadMilestone(ctx, args.taskId, args.milestoneId);
  if (milestone === null) {
    throw new Error(`Milestone ${args.milestoneId} not found in task ${args.taskId}`);
  }
  const trimmed = args.title.trim();
  if (trimmed.length === 0) {
    throw new Error('Slice title must not be empty');
  }
  const allSlices = await listSlices(ctx, args.taskId);
  const siblingCount = allSlices.filter((s) => s.milestoneId === args.milestoneId).length;
  const now = nowIso();
  const slice: Slice = {
    id: generateSliceId(),
    milestoneId: args.milestoneId,
    title: trimmed,
    description: args.description ?? null,
    verification: args.verification,
    status: SliceStatus.Pending,
    orderIndex: siblingCount,
    createdAt: now,
    updatedAt: now,
  };
  await saveSlice(ctx, args.taskId, slice);
  await appendEvent(ctx, {
    taskId: args.taskId,
    kind: EventKind.SliceCreated,
    payload: {
      sliceId: slice.id,
      milestoneId: args.milestoneId,
    },
    ts: now,
  });
  return {
    slice,
  };
}

//#endregion
