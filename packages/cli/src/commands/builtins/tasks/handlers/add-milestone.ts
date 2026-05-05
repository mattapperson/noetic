import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent } from '../fs-store.js';
import { hierarchyPaths } from '../hierarchy/paths.js';
import type { Milestone } from '../hierarchy/schemas.js';
import { generateMilestoneId, MilestoneStatus } from '../hierarchy/schemas.js';
import { listMilestones, saveMilestone } from '../hierarchy/store.js';
import { EventKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface AddMilestoneArgs {
  readonly taskId: string;
  readonly title: string;
  readonly verification: string;
  readonly description?: string;
}

export interface AddMilestoneResult {
  readonly milestone: Milestone;
}

//#endregion

//#region Public API

/**
 * Append a milestone to a task's hierarchy. Creates the
 * `hierarchy/milestones` directory on first call so a freshly-planned
 * task does not need an explicit init step.
 */
export async function addMilestoneHandler(
  ctx: TaskStoreContext,
  args: AddMilestoneArgs,
): Promise<AddMilestoneResult> {
  await resolveTask(ctx, args.taskId);
  const trimmed = args.title.trim();
  if (trimmed.length === 0) {
    throw new Error('Milestone title must not be empty');
  }
  const paths = hierarchyPaths(ctx, args.taskId);
  await ctx.fs.mkdir(paths.milestones);
  const existing = await listMilestones(ctx, args.taskId);
  const now = nowIso();
  const milestone: Milestone = {
    id: generateMilestoneId(),
    taskId: args.taskId,
    title: trimmed,
    description: args.description ?? null,
    verification: args.verification,
    status: MilestoneStatus.Pending,
    orderIndex: existing.length,
    createdAt: now,
    updatedAt: now,
  };
  await saveMilestone(ctx, args.taskId, milestone);
  await appendEvent(ctx, {
    taskId: args.taskId,
    kind: EventKind.MilestoneCreated,
    payload: {
      milestoneId: milestone.id,
    },
    ts: now,
  });
  return {
    milestone,
  };
}

//#endregion
