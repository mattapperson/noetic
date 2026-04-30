import { emitTaskEvent } from '../events.js';
import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent } from '../fs-store.js';
import type { Assertion } from '../hierarchy/schemas.js';
import { AssertionStatus, generateAssertionId } from '../hierarchy/schemas.js';
import { listAssertions, loadMilestone, saveAssertion } from '../hierarchy/store.js';
import { EventKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface AddAssertionArgs {
  readonly taskId: string;
  readonly milestoneId: string;
  readonly title: string;
  readonly assertion: string;
  readonly featureIds?: ReadonlyArray<string>;
}

export interface AddAssertionResult {
  readonly assertion: Assertion;
}

//#endregion

//#region Public API

/** Append an assertion under an existing milestone. */
export async function addAssertionHandler(
  ctx: TaskStoreContext,
  args: AddAssertionArgs,
): Promise<AddAssertionResult> {
  await resolveTask(ctx, args.taskId);
  const milestone = await loadMilestone(ctx, args.taskId, args.milestoneId);
  if (milestone === null) {
    throw new Error(`Milestone ${args.milestoneId} not found in task ${args.taskId}`);
  }
  const trimmed = args.title.trim();
  if (trimmed.length === 0) {
    throw new Error('Assertion title must not be empty');
  }
  const allAssertions = await listAssertions(ctx, args.taskId);
  const siblingCount = allAssertions.filter((a) => a.milestoneId === args.milestoneId).length;
  const now = nowIso();
  const assertion: Assertion = {
    id: generateAssertionId(),
    milestoneId: args.milestoneId,
    title: trimmed,
    assertion: args.assertion,
    status: AssertionStatus.Pending,
    orderIndex: siblingCount,
    featureIds: [
      ...(args.featureIds ?? []),
    ],
    createdAt: now,
    updatedAt: now,
  };
  await saveAssertion(ctx, args.taskId, assertion);
  const event = await appendEvent(ctx, {
    taskId: args.taskId,
    kind: EventKind.AssertionCreated,
    payload: {
      assertionId: assertion.id,
      milestoneId: args.milestoneId,
    },
    ts: now,
  });
  emitTaskEvent(event);
  return {
    assertion,
  };
}

//#endregion
