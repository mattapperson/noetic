import { join } from 'node:path';

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

export function hierarchyPaths(projectRoot: string, taskId: string): HierarchyPaths {
  const root = taskDirPaths(projectRoot, taskId).hierarchy;
  return {
    root,
    milestones: join(root, 'milestones'),
    slices: join(root, 'slices'),
    features: join(root, 'features'),
    assertions: join(root, 'assertions'),
    interviewSessions: join(root, 'interview-sessions'),
  };
}

export function milestonePath(projectRoot: string, taskId: string, milestoneId: string): string {
  return join(hierarchyPaths(projectRoot, taskId).milestones, `${milestoneId}.json`);
}

export function slicePath(projectRoot: string, taskId: string, sliceId: string): string {
  return join(hierarchyPaths(projectRoot, taskId).slices, `${sliceId}.json`);
}

export function featureDirPaths(
  projectRoot: string,
  taskId: string,
  featureId: string,
): FeatureDirPaths {
  const dir = join(hierarchyPaths(projectRoot, taskId).features, featureId);
  return {
    dir,
    feature: join(dir, 'feature.json'),
    validatorRuns: join(dir, 'validator-runs'),
    fixLineage: join(dir, 'fix-lineage.jsonl'),
  };
}

export interface ValidatorRunPathArgs {
  readonly projectRoot: string;
  readonly taskId: string;
  readonly featureId: string;
  readonly runId: string;
}

export function validatorRunPath(args: ValidatorRunPathArgs): string {
  const dirs = featureDirPaths(args.projectRoot, args.taskId, args.featureId);
  return join(dirs.validatorRuns, `${args.runId}.json`);
}

export function assertionPath(projectRoot: string, taskId: string, assertionId: string): string {
  return join(hierarchyPaths(projectRoot, taskId).assertions, `${assertionId}.json`);
}

export function interviewSessionPath(
  projectRoot: string,
  taskId: string,
  sessionId: string,
): string {
  return join(hierarchyPaths(projectRoot, taskId).interviewSessions, `${sessionId}.json`);
}

//#endregion
