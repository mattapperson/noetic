import type { Signaller } from '../agent-ci-control.js';
import { defaultSignaller, verifyPidIdentity } from '../agent-ci-control.js';
import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent, deleteTaskDir } from '../fs-store.js';
import { getTaskHierarchy } from '../hierarchy/aggregate.js';
import { ValidatorRunStatus } from '../hierarchy/schemas.js';
import { listValidatorRuns } from '../hierarchy/validator.js';
import { loadImplementer } from '../implementer-state.js';
import { loadPlanner } from '../planner-state.js';
import { loadRunner } from '../runner-state.js';
import { EventKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface DeleteTaskArgs {
  readonly taskId: string;
  /**
   * Override the live-runner / running-validator guards. Without this,
   * deletion is refused while any subprocess is still attached to the
   * task directory.
   */
  readonly force?: boolean;
  /**
   * Test seam: override the default signaller used for live-pid checks
   * on the agent-ci, implementer, and planner runner sidecars.
   * Defaults to `defaultSignaller`.
   */
  readonly signaller?: Signaller;
}

export interface DeleteTaskResult {
  readonly taskId: string;
}

/**
 * Discriminator for the kind of subprocess sidecar blocking a delete.
 * Surfaced in the error message so the user knows which subsystem is
 * still attached.
 */
export const SidecarKind = {
  AgentCi: 'agent-ci',
  Implementer: 'implementer',
  Planner: 'planner',
} as const;

export type SidecarKind = (typeof SidecarKind)[keyof typeof SidecarKind];

export interface LiveSidecar {
  readonly kind: SidecarKind;
  readonly pid: number;
  readonly sessionId: string;
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

/**
 * Returns one entry per live subprocess sidecar attached to the task,
 * so the caller can name the blocking subsystem in the error message.
 * Stale sidecars (dead pid, recycled pid, `ps` failure) are filtered
 * out via {@link verifyPidIdentity}.
 */
export async function findLiveSidecars(
  ctx: TaskStoreContext,
  taskId: string,
  signaller: Signaller = defaultSignaller,
): Promise<ReadonlyArray<LiveSidecar>> {
  const [runner, implementer, planner] = await Promise.all([
    loadRunner(ctx, taskId),
    loadImplementer(ctx, taskId),
    loadPlanner(ctx, taskId),
  ]);
  const out: LiveSidecar[] = [];
  if (runner !== null && verifyPidIdentity(signaller, runner.pid, runner.pidStarttime)) {
    out.push({
      kind: SidecarKind.AgentCi,
      pid: runner.pid,
      sessionId: runner.sessionId,
    });
  }
  if (
    implementer !== null &&
    verifyPidIdentity(signaller, implementer.pid, implementer.pidStarttime)
  ) {
    out.push({
      kind: SidecarKind.Implementer,
      pid: implementer.pid,
      sessionId: implementer.sessionId,
    });
  }
  if (planner !== null && verifyPidIdentity(signaller, planner.pid, planner.pidStarttime)) {
    out.push({
      kind: SidecarKind.Planner,
      pid: planner.pid,
      sessionId: planner.sessionId,
    });
  }
  return out;
}

//#endregion

//#region Public API

/**
 * Hard-delete a task. Emits `task:deleted` so listeners that mirror
 * state to other surfaces (UI lists, search indexes) can drop the
 * task's row, then removes the on-disk directory.
 *
 * Refuses to delete if a live agent-ci, implementer, or planner
 * sidecar is attached, or any feature under the task has a `running`
 * validator run — the subprocess could be writing into the task dir
 * mid-delete. Pass `force: true` to override.
 */
export async function deleteTaskHandler(
  ctx: TaskStoreContext,
  args: DeleteTaskArgs,
): Promise<DeleteTaskResult> {
  const existing = await resolveTask(ctx, args.taskId);
  if (args.force !== true) {
    const liveSidecars = await findLiveSidecars(ctx, existing.id, args.signaller);
    if (liveSidecars.length > 0) {
      const summary = liveSidecars.map((sc) => `${sc.kind} runner pid=${sc.pid}`).join(', ');
      throw new Error(
        `Refusing to delete ${existing.id}: ${summary} still attached. Pass --force to override.`,
      );
    }
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
