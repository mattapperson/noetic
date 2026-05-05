import { join } from 'node:path';

import type { TasksRootCtx } from '@noetic/code-agent/tasks/store/fs-node';

import { taskDirPaths } from '../paths.js';

//#region Types

/** On-disk layout for a task's hierarchy subtree. */
export interface HierarchyPaths {
  /** `<taskDir>/hierarchy` */
  readonly root: string;
  /** `<root>/milestones` */
  readonly milestones: string;
  /** `<root>/slices` */
  readonly slices: string;
  /** `<root>/features` */
  readonly features: string;
  /** `<root>/assertions` */
  readonly assertions: string;
  /** `<root>/interview-sessions` */
  readonly interviewSessions: string;
}

export interface FeatureDirPaths {
  /** `<features>/<featureId>` */
  readonly dir: string;
  /** `<dir>/feature.json` canonical record. */
  readonly feature: string;
  /** `<dir>/validator-runs` */
  readonly validatorRuns: string;
  /** `<dir>/fix-lineage.jsonl` append-only outgoing lineage. */
  readonly fixLineage: string;
}

//#endregion

//#region Helpers

export function hierarchyPaths(ctx: TasksRootCtx, taskId: string): HierarchyPaths {
  const root = taskDirPaths(ctx, taskId).hierarchy;
  return {
    root,
    milestones: join(root, 'milestones'),
    slices: join(root, 'slices'),
    features: join(root, 'features'),
    assertions: join(root, 'assertions'),
    interviewSessions: join(root, 'interview-sessions'),
  };
}

export function milestonePath(ctx: TasksRootCtx, taskId: string, milestoneId: string): string {
  return join(hierarchyPaths(ctx, taskId).milestones, `${milestoneId}.json`);
}

export function slicePath(ctx: TasksRootCtx, taskId: string, sliceId: string): string {
  return join(hierarchyPaths(ctx, taskId).slices, `${sliceId}.json`);
}

export function featureDirPaths(
  ctx: TasksRootCtx,
  taskId: string,
  featureId: string,
): FeatureDirPaths {
  const dir = join(hierarchyPaths(ctx, taskId).features, featureId);
  return {
    dir,
    feature: join(dir, 'feature.json'),
    validatorRuns: join(dir, 'validator-runs'),
    fixLineage: join(dir, 'fix-lineage.jsonl'),
  };
}

export interface ValidatorRunPathArgs {
  readonly ctx: TasksRootCtx;
  readonly taskId: string;
  readonly featureId: string;
  readonly runId: string;
}

export function validatorRunPath(args: ValidatorRunPathArgs): string {
  const dirs = featureDirPaths(args.ctx, args.taskId, args.featureId);
  return join(dirs.validatorRuns, `${args.runId}.json`);
}

export function assertionPath(ctx: TasksRootCtx, taskId: string, assertionId: string): string {
  return join(hierarchyPaths(ctx, taskId).assertions, `${assertionId}.json`);
}

export function interviewSessionPath(ctx: TasksRootCtx, taskId: string, sessionId: string): string {
  return join(hierarchyPaths(ctx, taskId).interviewSessions, `${sessionId}.json`);
}

//#endregion
