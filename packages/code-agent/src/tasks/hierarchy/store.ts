import type { z } from 'zod';

import { isEnoent } from '../_fs-errors.js';
import type { TaskStoreContext } from '../fs-store.js';
import * as path from '../path-utils.js';
import { tempPath } from '../paths.js';
import { randomBase64Url } from '../random.js';
import {
  assertionPath,
  featureDirPaths,
  hierarchyPaths,
  interviewSessionPath,
  milestonePath,
  slicePath,
} from './paths.js';
import type { Assertion, Feature, InterviewSession, Milestone, Slice } from './schemas.js';
import {
  AssertionIdSchema,
  AssertionSchema,
  FeatureIdSchema,
  FeatureSchema,
  InterviewSessionIdSchema,
  InterviewSessionSchema,
  MilestoneIdSchema,
  MilestoneSchema,
  SliceIdSchema,
  SliceSchema,
} from './schemas.js';

//#region Helpers

function randomSalt(): string {
  return randomBase64Url(6);
}

async function atomicWriteJson(
  ctx: TaskStoreContext,
  target: string,
  value: unknown,
): Promise<void> {
  await ctx.fs.mkdir(path.dirname(target));
  const tmp = tempPath(target, randomSalt());
  await ctx.fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await ctx.fs.rename(tmp, target);
  } catch (err) {
    await ctx.fs.rm(tmp, {
      force: true,
    });
    throw err;
  }
}

async function readJson<T>(
  ctx: TaskStoreContext,
  target: string,
  parse: (raw: unknown) => T,
): Promise<T | null> {
  let text: string;
  try {
    text = await ctx.fs.readFileText(target);
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }
  if (text.length === 0) {
    return null;
  }
  return parse(JSON.parse(text));
}

async function listDirSafe(ctx: TaskStoreContext, dir: string): Promise<string[]> {
  try {
    return await ctx.fs.readdir(dir);
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }
}

interface FlatStoreSpec<
  T extends {
    id: string;
  },
> {
  readonly pathFor: (id: string) => string;
  readonly dirFor: () => string;
  readonly schema: z.ZodType<T>;
  readonly idSchema: z.ZodType<string>;
  readonly suffix: string;
}

async function loadFlat<
  T extends {
    id: string;
  },
>(ctx: TaskStoreContext, spec: FlatStoreSpec<T>, id: string): Promise<T | null> {
  if (!spec.idSchema.safeParse(id).success) {
    return null;
  }
  return readJson<T>(ctx, spec.pathFor(id), (raw) => spec.schema.parse(raw));
}

async function saveFlat<
  T extends {
    id: string;
  },
>(ctx: TaskStoreContext, spec: FlatStoreSpec<T>, value: T): Promise<void> {
  const validated = spec.schema.parse(value);
  await atomicWriteJson(ctx, spec.pathFor(validated.id), validated);
}

async function listFlat<
  T extends {
    id: string;
  },
>(ctx: TaskStoreContext, spec: FlatStoreSpec<T>): Promise<T[]> {
  const entries = await listDirSafe(ctx, spec.dirFor());
  const out: T[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(spec.suffix)) {
      continue;
    }
    const id = entry.slice(0, entry.length - spec.suffix.length);
    if (!spec.idSchema.safeParse(id).success) {
      continue;
    }
    const value = await readJson<T>(ctx, spec.pathFor(id), (raw) => spec.schema.parse(raw));
    if (value !== null) {
      out.push(value);
    }
  }
  return out;
}

async function deleteFlat(ctx: TaskStoreContext, pathFor: string): Promise<void> {
  await ctx.fs.rm(pathFor, {
    force: true,
  });
}

//#endregion

//#region Spec factories

function milestoneSpec(ctx: TaskStoreContext, taskId: string): FlatStoreSpec<Milestone> {
  return {
    pathFor: (id) => milestonePath(ctx, taskId, id),
    dirFor: () => hierarchyPaths(ctx, taskId).milestones,
    schema: MilestoneSchema,
    idSchema: MilestoneIdSchema,
    suffix: '.json',
  };
}

function sliceSpec(ctx: TaskStoreContext, taskId: string): FlatStoreSpec<Slice> {
  return {
    pathFor: (id) => slicePath(ctx, taskId, id),
    dirFor: () => hierarchyPaths(ctx, taskId).slices,
    schema: SliceSchema,
    idSchema: SliceIdSchema,
    suffix: '.json',
  };
}

function assertionSpec(ctx: TaskStoreContext, taskId: string): FlatStoreSpec<Assertion> {
  return {
    pathFor: (id) => assertionPath(ctx, taskId, id),
    dirFor: () => hierarchyPaths(ctx, taskId).assertions,
    schema: AssertionSchema,
    idSchema: AssertionIdSchema,
    suffix: '.json',
  };
}

function interviewSessionSpec(
  ctx: TaskStoreContext,
  taskId: string,
): FlatStoreSpec<InterviewSession> {
  return {
    pathFor: (id) => interviewSessionPath(ctx, taskId, id),
    dirFor: () => hierarchyPaths(ctx, taskId).interviewSessions,
    schema: InterviewSessionSchema,
    idSchema: InterviewSessionIdSchema,
    suffix: '.json',
  };
}

//#endregion

//#region Milestones

export function loadMilestone(
  ctx: TaskStoreContext,
  taskId: string,
  milestoneId: string,
): Promise<Milestone | null> {
  return loadFlat(ctx, milestoneSpec(ctx, taskId), milestoneId);
}

export function saveMilestone(
  ctx: TaskStoreContext,
  taskId: string,
  milestone: Milestone,
): Promise<void> {
  return saveFlat(ctx, milestoneSpec(ctx, taskId), milestone);
}

export function listMilestones(ctx: TaskStoreContext, taskId: string): Promise<Milestone[]> {
  return listFlat(ctx, milestoneSpec(ctx, taskId));
}

export function deleteMilestone(
  ctx: TaskStoreContext,
  taskId: string,
  milestoneId: string,
): Promise<void> {
  return deleteFlat(ctx, milestonePath(ctx, taskId, milestoneId));
}

//#endregion

//#region Slices

export function loadSlice(
  ctx: TaskStoreContext,
  taskId: string,
  sliceId: string,
): Promise<Slice | null> {
  return loadFlat(ctx, sliceSpec(ctx, taskId), sliceId);
}

export function saveSlice(ctx: TaskStoreContext, taskId: string, slice: Slice): Promise<void> {
  return saveFlat(ctx, sliceSpec(ctx, taskId), slice);
}

export function listSlices(ctx: TaskStoreContext, taskId: string): Promise<Slice[]> {
  return listFlat(ctx, sliceSpec(ctx, taskId));
}

export function deleteSlice(ctx: TaskStoreContext, taskId: string, sliceId: string): Promise<void> {
  return deleteFlat(ctx, slicePath(ctx, taskId, sliceId));
}

//#endregion

//#region Features (per-feature subdir)

export async function loadFeature(
  ctx: TaskStoreContext,
  taskId: string,
  featureId: string,
): Promise<Feature | null> {
  if (!FeatureIdSchema.safeParse(featureId).success) {
    return null;
  }
  const paths = featureDirPaths(ctx, taskId, featureId);
  return readJson<Feature>(ctx, paths.feature, (raw) => FeatureSchema.parse(raw));
}

export async function saveFeature(
  ctx: TaskStoreContext,
  taskId: string,
  feature: Feature,
): Promise<void> {
  const validated = FeatureSchema.parse(feature);
  const paths = featureDirPaths(ctx, taskId, validated.id);
  await ctx.fs.mkdir(paths.dir);
  await atomicWriteJson(ctx, paths.feature, validated);
}

export async function listFeatures(ctx: TaskStoreContext, taskId: string): Promise<Feature[]> {
  const featuresRoot = hierarchyPaths(ctx, taskId).features;
  const entries = await listDirSafe(ctx, featuresRoot);
  const out: Feature[] = [];
  for (const entry of entries) {
    if (!FeatureIdSchema.safeParse(entry).success) {
      continue;
    }
    const feature = await loadFeature(ctx, taskId, entry);
    if (feature !== null) {
      out.push(feature);
    }
  }
  return out;
}

export async function deleteFeature(
  ctx: TaskStoreContext,
  taskId: string,
  featureId: string,
): Promise<void> {
  const paths = featureDirPaths(ctx, taskId, featureId);
  await ctx.fs.rm(paths.dir, {
    recursive: true,
    force: true,
  });
}

//#endregion

//#region Assertions

export function loadAssertion(
  ctx: TaskStoreContext,
  taskId: string,
  assertionId: string,
): Promise<Assertion | null> {
  return loadFlat(ctx, assertionSpec(ctx, taskId), assertionId);
}

export function saveAssertion(
  ctx: TaskStoreContext,
  taskId: string,
  assertion: Assertion,
): Promise<void> {
  return saveFlat(ctx, assertionSpec(ctx, taskId), assertion);
}

export function listAssertions(ctx: TaskStoreContext, taskId: string): Promise<Assertion[]> {
  return listFlat(ctx, assertionSpec(ctx, taskId));
}

export function deleteAssertion(
  ctx: TaskStoreContext,
  taskId: string,
  assertionId: string,
): Promise<void> {
  return deleteFlat(ctx, assertionPath(ctx, taskId, assertionId));
}

//#endregion

//#region Interview sessions

export function loadInterviewSession(
  ctx: TaskStoreContext,
  taskId: string,
  sessionId: string,
): Promise<InterviewSession | null> {
  return loadFlat(ctx, interviewSessionSpec(ctx, taskId), sessionId);
}

export function saveInterviewSession(
  ctx: TaskStoreContext,
  taskId: string,
  session: InterviewSession,
): Promise<void> {
  return saveFlat(ctx, interviewSessionSpec(ctx, taskId), session);
}

export function listInterviewSessions(
  ctx: TaskStoreContext,
  taskId: string,
): Promise<InterviewSession[]> {
  return listFlat(ctx, interviewSessionSpec(ctx, taskId));
}

//#endregion

//#region Whole-hierarchy helpers

/** Hard-delete the entire `hierarchy/` subtree for a task. */
export async function clearTaskHierarchy(ctx: TaskStoreContext, taskId: string): Promise<void> {
  const paths = hierarchyPaths(ctx, taskId);
  await ctx.fs.rm(paths.root, {
    recursive: true,
    force: true,
  });
}

//#endregion
