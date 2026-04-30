import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent, deleteTaskDir } from '../fs-store.js';
import { getTaskHierarchy } from '../hierarchy/aggregate.js';
import { ValidatorRunStatus } from '../hierarchy/schemas.js';
import { listValidatorRuns } from '../hierarchy/validator.js';
import { EventKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface DeleteTaskArgs {
  readonly taskId: string;
  /**
   * Override the running-validator guard. Without this, deletion is
   * refused while any feature under the task has a `running` validator
   * run open (the subprocess could be writing into the task dir).
   */
  readonly force?: boolean;
}

export interface DeleteTaskResult {
  readonly taskId: string;
}

//#endregion

//#region Helpers

/**
 * Look for any `running` validator run under the task's hierarchy.
 * Returns the first hit's run id, or null if all runs are terminal.
 */
async function findActiveValidatorRunId(
  ctx: TaskStoreContext,
  taskId: string,
): Promise<string | null> {
  const hierarchy = await getTaskHierarchy(ctx, taskId);
  if (hierarchy === null) {
    return null;
  }
  for (const milestone of hierarchy.milestones) {
    for (const slice of milestone.slices) {
      for (const feature of slice.features) {
        const runs = await listValidatorRuns(
          {
            ...ctx,
            taskId,
          },
          feature.id,
        );
        for (const run of runs) {
          if (run.status === ValidatorRunStatus.Running && run.completedAt === null) {
            return run.id;
          }
        }
      }
    }
  }
  return null;
}

//#endregion

//#region Public API

/**
 * Hard-delete a task. Emits `task:deleted` so listeners that mirror
 * state to other surfaces (UI lists, search indexes) can drop the
 * task's row, then removes the on-disk directory.
 *
 * Refuses to delete if any feature under the task has a `running`
 * validator run, since the subprocess could be writing into the
 * task dir mid-delete. Pass `force: true` to override.
 */
export async function deleteTaskHandler(
  ctx: TaskStoreContext,
  args: DeleteTaskArgs,
): Promise<DeleteTaskResult> {
  const existing = await resolveTask(ctx, args.taskId);
  if (args.force !== true) {
    const activeRunId = await findActiveValidatorRunId(ctx, existing.id);
    if (activeRunId !== null) {
      throw new Error(
        `Refusing to delete ${existing.id}: validator run ${activeRunId} is still running. Pass --force to override.`,
      );
    }
  }
  const ts = nowIso();
  await appendEvent(ctx, {
    taskId: existing.id,
    kind: EventKind.TaskDeleted,
    payload: {
      reason: 'deleted',
    },
    ts,
  });
  await deleteTaskDir(ctx, existing.id);
  return {
    taskId: existing.id,
  };
}

//#endregion
