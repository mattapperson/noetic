import { z } from 'zod';

import { generateId, ID_LENGTH, IdPrefix } from '../schemas.js';

//#region ID schemas

function idSchema(prefix: string) {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}-[A-Za-z0-9_-]{${ID_LENGTH}}$`),
      `must be of the form ${prefix}-<${ID_LENGTH} chars>`,
    );
}

export const MilestoneIdSchema = idSchema(IdPrefix.Milestone);
export const SliceIdSchema = idSchema(IdPrefix.Slice);
export const FeatureIdSchema = idSchema(IdPrefix.Feature);
export const AssertionIdSchema = idSchema(IdPrefix.Assertion);
export const ValidatorRunIdSchema = idSchema(IdPrefix.ValidatorRun);
export const FixLineageIdSchema = idSchema(IdPrefix.FixLineage);
export const InterviewSessionIdSchema = idSchema(IdPrefix.InterviewSession);

export function generateMilestoneId(): string {
  return generateId(IdPrefix.Milestone);
}
export function generateSliceId(): string {
  return generateId(IdPrefix.Slice);
}
export function generateFeatureId(): string {
  return generateId(IdPrefix.Feature);
}
export function generateAssertionId(): string {
  return generateId(IdPrefix.Assertion);
}
export function generateValidatorRunId(): string {
  return generateId(IdPrefix.ValidatorRun);
}
export function generateFixLineageId(): string {
  return generateId(IdPrefix.FixLineage);
}
export function generateInterviewSessionId(): string {
  return generateId(IdPrefix.InterviewSession);
}

//#endregion

//#region Status enums

export const MilestoneStatus = {
  Pending: 'pending',
  Active: 'active',
  Complete: 'complete',
  Blocked: 'blocked',
} as const;

export type MilestoneStatus = (typeof MilestoneStatus)[keyof typeof MilestoneStatus];

export const SliceStatus = {
  Pending: 'pending',
  Active: 'active',
  Complete: 'complete',
  Blocked: 'blocked',
} as const;

export type SliceStatus = (typeof SliceStatus)[keyof typeof SliceStatus];

export const FeatureStatus = {
  Defined: 'defined',
  Triaged: 'triaged',
  Done: 'done',
  Blocked: 'blocked',
} as const;

export type FeatureStatus = (typeof FeatureStatus)[keyof typeof FeatureStatus];

export const FeatureLoopState = {
  Idle: 'idle',
  Implementing: 'implementing',
  Validating: 'validating',
  Passed: 'passed',
  NeedsFix: 'needs_fix',
  Blocked: 'blocked',
} as const;

export type FeatureLoopState = (typeof FeatureLoopState)[keyof typeof FeatureLoopState];

export const AssertionStatus = {
  Pending: 'pending',
  Passed: 'passed',
  Failed: 'failed',
  Blocked: 'blocked',
} as const;

export type AssertionStatus = (typeof AssertionStatus)[keyof typeof AssertionStatus];

export const ValidatorRunStatus = {
  Pending: 'pending',
  Running: 'running',
  Pass: 'pass',
  Fail: 'fail',
  Blocked: 'blocked',
  Error: 'error',
} as const;

export type ValidatorRunStatus = (typeof ValidatorRunStatus)[keyof typeof ValidatorRunStatus];

export const InterviewSessionStatus = {
  Active: 'active',
  Complete: 'complete',
  Cancelled: 'cancelled',
} as const;

export type InterviewSessionStatus =
  (typeof InterviewSessionStatus)[keyof typeof InterviewSessionStatus];

//#endregion

//#region Constants

/** Default cap on how many implementation/validator attempts a feature gets. */
export const DEFAULT_IMPLEMENTATION_RETRY_BUDGET = 3;

//#endregion

//#region Entity schemas

export const MilestoneSchema = z.object({
  id: MilestoneIdSchema,
  taskId: z.string(),
  title: z.string().min(1),
  description: z.string().nullable(),
  verification: z.string(),
  status: z.enum([
    MilestoneStatus.Pending,
    MilestoneStatus.Active,
    MilestoneStatus.Complete,
    MilestoneStatus.Blocked,
  ]),
  orderIndex: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Milestone = z.infer<typeof MilestoneSchema>;

export const SliceSchema = z.object({
  id: SliceIdSchema,
  milestoneId: MilestoneIdSchema,
  title: z.string().min(1),
  description: z.string().nullable(),
  verification: z.string(),
  status: z.enum([
    SliceStatus.Pending,
    SliceStatus.Active,
    SliceStatus.Complete,
    SliceStatus.Blocked,
  ]),
  orderIndex: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Slice = z.infer<typeof SliceSchema>;

export const FeatureSchema = z.object({
  id: FeatureIdSchema,
  sliceId: SliceIdSchema,
  title: z.string().min(1),
  description: z.string().nullable(),
  acceptanceCriteria: z.string(),
  status: z.enum([
    FeatureStatus.Defined,
    FeatureStatus.Triaged,
    FeatureStatus.Done,
    FeatureStatus.Blocked,
  ]),
  loopState: z.enum([
    FeatureLoopState.Idle,
    FeatureLoopState.Implementing,
    FeatureLoopState.Validating,
    FeatureLoopState.Passed,
    FeatureLoopState.NeedsFix,
    FeatureLoopState.Blocked,
  ]),
  implementationAttemptCount: z.number().int().nonnegative(),
  validatorAttemptCount: z.number().int().nonnegative(),
  /** When the feature has been triaged into a leaf task, the linked task id. */
  taskId: z.string().nullable(),
  /** If this feature was generated as a fix for a failing validator run, the source feature id. */
  generatedFromFeatureId: FeatureIdSchema.nullable(),
  /** And the run id that generated it. */
  generatedFromRunId: ValidatorRunIdSchema.nullable(),
  blockedReason: z.string().nullable(),
  orderIndex: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Feature = z.infer<typeof FeatureSchema>;

export const AssertionSchema = z.object({
  id: AssertionIdSchema,
  milestoneId: MilestoneIdSchema,
  title: z.string().min(1),
  assertion: z.string(),
  status: z.enum([
    AssertionStatus.Pending,
    AssertionStatus.Passed,
    AssertionStatus.Failed,
    AssertionStatus.Blocked,
  ]),
  orderIndex: z.number().int().nonnegative(),
  /** Feature ids this assertion covers. */
  featureIds: z.array(FeatureIdSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Assertion = z.infer<typeof AssertionSchema>;

export const ValidatorRunSchema = z.object({
  id: ValidatorRunIdSchema,
  featureId: FeatureIdSchema,
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  status: z.enum([
    ValidatorRunStatus.Pending,
    ValidatorRunStatus.Running,
    ValidatorRunStatus.Pass,
    ValidatorRunStatus.Fail,
    ValidatorRunStatus.Blocked,
    ValidatorRunStatus.Error,
  ]),
  /** Free-form structured result payload (test report, error details, etc.). */
  result: z.record(z.string(), z.unknown()).nullable(),
  pid: z.number().int().nullable(),
  pidStarttime: z.string().nullable(),
  pausedAt: z.string().nullable(),
});

export type ValidatorRun = z.infer<typeof ValidatorRunSchema>;

/**
 * Append-only lineage record connecting a failing source feature to the
 * generated fix feature and the validator run that triggered the fix.
 */
export const FixLineageSchema = z.object({
  id: FixLineageIdSchema,
  sourceFeatureId: FeatureIdSchema,
  fixFeatureId: FeatureIdSchema,
  validatorRunId: ValidatorRunIdSchema,
  createdAt: z.string(),
});

export type FixLineage = z.infer<typeof FixLineageSchema>;

export const InterviewSessionSchema = z.object({
  id: InterviewSessionIdSchema,
  taskId: z.string(),
  status: z.enum([
    InterviewSessionStatus.Active,
    InterviewSessionStatus.Complete,
    InterviewSessionStatus.Cancelled,
  ]),
  /** Free-form interview state — Q&A pairs, partial plan, etc. */
  state: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type InterviewSession = z.infer<typeof InterviewSessionSchema>;

//#endregion

//#region Aggregate views

/**
 * The full hierarchy attached to a structured task, lazily assembled by
 * the store. Mirrors the Drizzle-backed `MissionHierarchy` shape used by
 * the legacy mission daemons.
 */
export interface FeatureWithRuns extends Feature {
  validatorRuns: ValidatorRun[];
}

export interface SliceWithFeatures extends Slice {
  features: FeatureWithRuns[];
}

export interface MilestoneWithChildren extends Milestone {
  slices: SliceWithFeatures[];
  assertions: Assertion[];
}

export interface TaskHierarchy {
  taskId: string;
  milestones: MilestoneWithChildren[];
}

//#endregion

//#region Tree-input shapes (interview output)

/**
 * Shape of an interview's structured output that gets persisted into a
 * task's `hierarchy/` tree by `persistTaskHierarchy`. Mirrors the legacy
 * `MissionTreeInput` exactly so live-interview's prompts stay valid.
 */
export interface FeatureInput {
  title: string;
  description?: string | null;
  acceptanceCriteria: string;
}

export interface AssertionInput {
  title: string;
  assertion: string;
  featureIndices: number[];
}

export interface SliceInput {
  title: string;
  description?: string | null;
  verification: string;
  features: FeatureInput[];
}

export interface MilestoneInput {
  title: string;
  description?: string | null;
  verification: string;
  slices: SliceInput[];
  assertions: AssertionInput[];
}

export interface TaskHierarchyInput {
  milestones: MilestoneInput[];
}

//#endregion
