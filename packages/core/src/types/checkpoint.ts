import { z } from 'zod';

//#region Schema

/**
 * @public
 * Literal schema version stamped on every `CheckpointSnapshot`. Bumped when a
 * backward-incompatible change lands. `restore()` refuses to load snapshots
 * whose version is not recognised and surfaces a typed `NoeticConfigError`
 * (`code === 'CHECKPOINT_SCHEMA_MISMATCH'`) so hosts can discard cleanly.
 */
export const CheckpointSchemaVersion = 1;

/**
 * @public
 * One entry in the execution frontier — a pointer to a step currently in
 * flight on the parent's stack, plus the input/state snapshot required to
 * resume it.
 *
 * The frontier is intentionally lenient: frame `state` is treated as an
 * opaque JSON value because step `state` is user-defined. Parse/validate at
 * the call site when specific shape guarantees are needed.
 */
export const FrontierFrameSchema = z.object({
  /** Stable id of the step this frame represents. */
  stepId: z.string(),
  /** Serialisable input delivered to the step when it started. */
  input: z.unknown(),
  /** Optional per-frame state snapshot. */
  state: z.unknown().optional(),
});

/** @public Shape of a single frontier frame serialised inside a snapshot. */
export type FrontierFrame = z.infer<typeof FrontierFrameSchema>;

/**
 * @public
 * Working-directory snapshot captured at checkpoint time. `current` is the
 * active cwd; `previous` records the last value for parity with
 * `CwdState.previousCwd` which tools use for `cd -`.
 */
export const CwdSnapshotSchema = z.object({
  current: z.string().nullable(),
  previous: z.string().nullish(),
});

/** @public Cwd portion of a checkpoint snapshot. */
export type CwdSnapshot = z.infer<typeof CwdSnapshotSchema>;

/**
 * @public
 * Shape of an ask-user record that was pending at snapshot time. The actual
 * schema is owned by the code-agent `AskUserService`; we only need the outer
 * envelope here so the host can replay the queue into a restarted TUI modal.
 */
export const PendingAskUserSnapshotSchema = z.object({
  id: z.string(),
  input: z.unknown(),
  createdAt: z.number(),
});

/** @public Pending ask-user record captured in a snapshot. */
export type PendingAskUserSnapshot = z.infer<typeof PendingAskUserSnapshotSchema>;

/**
 * @public
 * Item log state captured in a snapshot. We store the ordered list of items
 * directly — the `ItemLogImpl` is append-only so the list is its own cursor.
 *
 * Items are carried as `unknown` here and re-parsed on restore via the
 * harness's `ItemSchemaRegistry`, which is the same gate production traffic
 * passes through.
 */
export const ItemLogSnapshotSchema = z.object({
  items: z.array(z.unknown()),
});

/** @public Item log portion of a snapshot. */
export type ItemLogSnapshot = z.infer<typeof ItemLogSnapshotSchema>;

/**
 * @public
 * Top-level checkpoint payload persisted through a `CheckpointStore`. Carries
 * a schema version so forward-incompatible changes can be rejected cleanly
 * instead of producing a silently corrupt restored context.
 */
export const CheckpointSnapshotSchema = z.object({
  schemaVersion: z.literal(CheckpointSchemaVersion),
  executionId: z.string(),
  threadId: z.string().optional(),
  resourceId: z.string().optional(),
  frontier: z.array(FrontierFrameSchema),
  layers: z.record(z.string(), z.unknown()),
  cwd: CwdSnapshotSchema.nullable(),
  askUser: z.array(PendingAskUserSnapshotSchema),
  itemLog: ItemLogSnapshotSchema,
  /** ISO-8601 timestamp of when the snapshot was taken. */
  capturedAt: z.string(),
});

/** @public Snapshot of an execution suitable for `CheckpointStore.save()`. */
export type CheckpointSnapshot = z.infer<typeof CheckpointSnapshotSchema>;

//#endregion
