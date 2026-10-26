import { z } from 'zod';

//#region Schema

/**
 * @public
 * Literal schema version stamped on every `CheckpointSnapshot`. Bumped when a
 * backward-incompatible change lands. `restore()` refuses to load snapshots
 * whose version is not recognised and surfaces a typed `NoeticConfigError`
 * (`code === 'CHECKPOINT_SCHEMA_MISMATCH'`) so hosts can discard cleanly.
 *
 * Version history:
 * - v1 → v2: built-in layer ids changed (`working-context` → `scratchpad`,
 *   `static-content` → `instructions`, `observational-context` →
 *   `observations`, `file-reference` → `filesystem`, `history-window` →
 *   `history`, and `durable-task-state` → `task-state`). `layers` is keyed by
 *   layer id, so a v1 snapshot carries state under ids no current layer reads
 *   — restoring it would silently drop that state. There is no migration;
 *   discard via `CheckpointStore.clear()` and start fresh.
 * - v2 → v3: `itemLog` holds the log as it stood when the run in flight began, not
 *   at the moment of capture, and `occurrences` records the dispatch counts from that
 *   same moment. A resumed run replays its recorded steps, which put their items
 *   back; a v2 log already holds them, so restoring it would duplicate history. No
 *   migration — discard and start fresh.
 */
export const CheckpointSchemaVersion = 3;

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
 * Item log state captured in a snapshot: the log as it stood when the run in
 * flight began, or the live log when no run is in flight. The steps a resumed run
 * replays put the rest back, from the items the step ledger recorded for each.
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
 * Channel state an execution used, captured so a restored execution sees the
 * same values and queued items. Only stored data is kept — parked receivers,
 * parked senders, and subscribers are live promises that cannot round-trip.
 * Topic channels hold no stored data, so they never appear.
 */
export const ChannelSnapshotSchema = z.discriminatedUnion('mode', [
  z.object({
    name: z.string(),
    mode: z.literal('value'),
    /** The last value written. Absent when the channel was never written. */
    value: z.unknown().optional(),
    hasValue: z.boolean(),
  }),
  z.object({
    name: z.string(),
    mode: z.literal('queue'),
    capacity: z.number(),
    /** Queued items, oldest first. */
    queue: z.array(z.unknown()),
  }),
]);

/** @public One channel's stored state inside a checkpoint snapshot. */
export type ChannelSnapshot = z.infer<typeof ChannelSnapshotSchema>;

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
  /**
   * Dispatch counts per `<parent path>/<step id>`, taken at the same moment as
   * `itemLog`. A restored context numbers its dispatches from here, so a resumed run
   * meets its recorded steps at the paths they were recorded under, and a later run
   * on the same execution does not land on an earlier run's paths.
   */
  occurrences: z.record(z.string(), z.number()),
  /**
   * Custom item types the context accepted (spec 34), so a restore can parse an
   * `itemLog` that holds them before the steps that declare them run again.
   */
  customItemTypes: z.array(z.string()).optional(),
  /**
   * The execution's `ctx.state` at capture time. Absent when the state does not survive
   * JSON encoding, in which case restore keeps whatever state the host passes.
   */
  state: z.unknown().optional(),
  /** Tokens and cost the execution had spent at capture time, so budgets carry over. */
  usage: z
    .object({
      tokens: z.object({
        input: z.number(),
        output: z.number(),
        total: z.number(),
        cached: z.number().optional(),
      }),
      cost: z.number(),
    })
    .optional(),
  /**
   * Stored state of every channel the execution used. Optional so snapshots
   * written before channels were captured still load (they restore with no
   * channel state).
   */
  channels: z.array(ChannelSnapshotSchema).optional(),
  /** ISO-8601 timestamp of when the snapshot was taken. */
  capturedAt: z.string(),
});

/** @public Snapshot of an execution suitable for `CheckpointStore.save()`. */
export type CheckpointSnapshot = z.infer<typeof CheckpointSnapshotSchema>;

//#endregion
