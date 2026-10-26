/**
 * The step completion ledger: what a resumed execution replays instead of re-running.
 *
 * The frontier records which steps were IN FLIGHT at snapshot time; it says nothing
 * about which ones finished, and a finished step leaves no trace once `leaveStep` drops
 * it. Resume therefore needs a separate record — and it must carry each step's OUTPUT,
 * not merely a "done" flag: steps consume the previous step's value, and a `callModel` step
 * re-run to catch up produces a different one than the rest of the run already saw.
 *
 * Entries are stored one key per step so appends are O(1). Folding the whole ledger
 * into the single `execution:<id>:snapshot` key would rewrite a growing blob on every
 * step — O(n²) bytes over a run.
 *
 * An entry's key is one of two forms (spec 23a § Identity). By default it is the step's
 * execution path (`ContextImpl.currentPath()`): positional, so a resumed run lines up
 * recorded outputs with steps by where they ran. A step with a `replayKey` is keyed
 * `key:<replayKey>` instead: content-addressed, so it finds its output wherever it
 * runs. A `durable: false` step has no key and is never recorded.
 *
 * An entry also carries what replay must put back: the items the step appended to its
 * context's item log (a checkpoint holds the log as it stood when the run began, so the
 * replayed steps rebuild the rest), and a hash of the step's input, so a step whose input
 * changed since it was recorded runs again instead of replaying an answer to a
 * different question.
 *
 * Sharding bounds the cost of one append but not the total, so retention is bounded on
 * two axes (`StepLedgerRetention`): an oversized entry is dropped rather than written,
 * and once `maxEntries` are live nothing more is recorded. Entries beneath a parent that
 * recorded are pruned, since a resumed run replays the parent without descending, so the
 * live count tracks the open part of the run rather than its length. Both degradations
 * are safe by construction — a missing entry re-runs its step, which costs work rather
 * than correctness.
 */

import type { StorageAdapter } from '@noetic-tools/context';
import { storageGetMany } from '@noetic-tools/context';
import { NoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';

//#region Entry

/** Marks a ledger key as a step's `replayKey` rather than its execution path. */
export const REPLAY_KEY_PREFIX = 'key:';

/** @public One completed step, keyed by its execution path or its `key:` replay key. */
export const StepLedgerEntrySchema = z.object({
  /**
   * Ledger key: the execution path (`ContextImpl.currentPath()`, unique per dispatch)
   * or `key:<replayKey>` for a step that sets `replayKey`.
   */
  path: z.string().min(1),
  stepId: z.string(),
  kind: z.string(),
  /** Replayed verbatim in place of re-running the step. */
  output: z.unknown(),
  /**
   * Hash of the step's input when it ran (`hashStepInput`). Replay requires the new
   * dispatch's input to hash the same. Absent when the input could not be encoded.
   */
  inputHash: z.string().optional(),
  /** Items the step appended to its context's item log, re-appended on replay. */
  items: z.array(z.unknown()).optional(),
  /**
   * Indices into `items` of those `step.emitItems` emitted (spec 01 § Emitting items),
   * streamed again on replay when the harness sets `emitItemsOnReplay`.
   */
  streamed: z.array(z.number().int().nonnegative()).optional(),
  completedAt: z.string(),
});

/** @public A completed step recorded for replay. */
export type StepLedgerEntry = z.infer<typeof StepLedgerEntrySchema>;

//#endregion

//#region Retention

/**
 * @public
 * Bounds on what one execution's ledger retains. Both caps degrade resume rather than
 * break it: a step with no entry simply runs again, so the worst case is repeated work
 * (and repeated side effects — see `specs/23a-step-level-resume` § "The side-effect
 * boundary"), never a replayed value that disagrees with the recorded run.
 */
export interface StepLedgerRetention {
  /**
   * Largest entry that will be recorded, in UTF-8 bytes of the JSON encoding of the
   * step's output plus the items it appended. A step whose entry exceeds this is not
   * recorded at all and re-runs on resume. Keeps one
   * entry inside the per-value limit real storage backends impose (128 KiB on several)
   * instead of failing the write. Pass `Infinity` to record any size.
   *
   * Defaults to `DEFAULT_STEP_LEDGER_RETENTION.maxEntryBytes` (128 KiB).
   */
  maxEntryBytes?: number;
  /**
   * Most live entries for one execution. Once the cap is reached nothing more is
   * recorded, so resume replays the head of the run and runs the rest again. Entries
   * beneath a parent that recorded do not count — they are pruned. Pass `Infinity` to
   * record without limit.
   *
   * Defaults to `DEFAULT_STEP_LEDGER_RETENTION.maxEntries` (1000).
   */
  maxEntries?: number;
}

/** @public Retention applied when a harness does not configure `stepLedgerRetention`. */
export const DEFAULT_STEP_LEDGER_RETENTION = {
  maxEntryBytes: 128 * 1024,
  maxEntries: 1e3,
} as const satisfies Required<StepLedgerRetention>;

/**
 * @public
 * Fill in defaults and reject nonsense. Validating loudly matters because every
 * misconfiguration here fails *silently* at runtime — a negative cap would drop every
 * entry and the run would look fine while resuming nothing.
 *
 * @throws NoeticConfigError `code: 'STEP_LEDGER_RETENTION_INVALID'`
 */
export function resolveStepLedgerRetention(
  retention?: StepLedgerRetention,
): Required<StepLedgerRetention> {
  const resolved = {
    maxEntryBytes: retention?.maxEntryBytes ?? DEFAULT_STEP_LEDGER_RETENTION.maxEntryBytes,
    maxEntries: retention?.maxEntries ?? DEFAULT_STEP_LEDGER_RETENTION.maxEntries,
  };
  for (const [field, value] of Object.entries(resolved)) {
    if (value === Number.POSITIVE_INFINITY) {
      continue;
    }
    if (!Number.isFinite(value) || value < 1) {
      throw new NoeticConfigError({
        code: 'STEP_LEDGER_RETENTION_INVALID',
        message: `stepLedgerRetention.${field} must be a positive number or Infinity (received ${String(value)}).`,
        hint: 'Omit the field to accept the default, or pass Infinity to disable the cap.',
      });
    }
  }
  return resolved;
}

/**
 * Whether `json` fits `cap` UTF-8 bytes. A UTF-16 code unit encodes to between 1 and 3
 * UTF-8 bytes (a surrogate pair is 2 units → 4 bytes, i.e. 2 per unit), so string
 * length brackets the byte count and decides most calls without encoding a megabyte
 * of output just to measure it.
 */
function fitsByteCap(json: string, cap: number): boolean {
  if (json.length > cap) {
    return false;
  }
  if (json.length * 3 <= cap) {
    return true;
  }
  return new TextEncoder().encode(json).length <= cap;
}

//#endregion

//#region Input hash

/**
 * @internal
 * A short, stable hash of a step input's JSON encoding, or undefined when the input
 * cannot be encoded (a cycle, a `BigInt`). A replayed output becomes the next step's
 * input after a JSON round trip, and `JSON.stringify` gives the same text for a value
 * and its round-tripped copy, so a resumed run hashes the same inputs the first run did.
 */
export function hashStepInput(input: unknown): string | undefined {
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    return undefined;
  }
  return cyrb53(json ?? 'undefined');
}

/**
 * 53-bit string hash (cyrb53, public domain: https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js).
 * Not cryptographic — it tells "same input" from "changed input", nothing more.
 */
function cyrb53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

//#endregion

//#region Store

/** Storage key prefix owning every ledger entry for one execution. */
export function stepLedgerPrefix(executionId: string): string {
  return `execution:${executionId}:ledger:`;
}

/**
 * @public
 * Everything one execution's ledger recovered from storage: the entries available for
 * replay plus the sequence bookkeeping a further append needs. `nextSeq` cannot be
 * derived from `entries.size` — pruning leaves gaps, and reusing a live sequence number
 * would overwrite an entry the resumed run still has to replay.
 */
export interface StepLedgerWindow {
  /** Recovered entries, keyed by execution path. Corrupt rows are skipped. */
  entries: Map<string, StepLedgerEntry>;
  /** Sequence number holding each recovered path, so pruning can delete it. */
  seqs: Map<string, number>;
  /** Sequence number the next append takes: highest recorded, plus one. */
  nextSeq: number;
}

/**
 * @public
 * Durable append-only ledger for one harness's executions. Backed by the same
 * `StorageAdapter` as the checkpoint store; it reserves the `:ledger:` suffix that
 * `CheckpointKeys` already sets aside.
 *
 * The store owns the key layout only. Retention policy lives in `StepLedger`, which
 * holds the per-execution sequence cursor that eviction needs.
 */
export interface StepLedgerStore {
  /** Record a completed step. Sequence numbers order entries within an execution. */
  append: (executionId: string, seq: number, entry: StepLedgerEntry) => Promise<void>;
  /** Drop one entry by sequence number. No-op when the key is absent. */
  delete: (executionId: string, seq: number) => Promise<void>;
  /** Everything recorded for an execution, plus its sequence bounds. */
  load: (executionId: string) => Promise<StepLedgerWindow>;
  /** Drop an execution's ledger (paired with `CheckpointStore.clear`). */
  clear: (executionId: string) => Promise<void>;
}

/** Zero-pad so lexicographic key order matches dispatch order under `list()`. */
function seqKey(executionId: string, seq: number): string {
  return `${stepLedgerPrefix(executionId)}${String(seq).padStart(8, '0')}`;
}

/** The sequence number a ledger key carries, or null when the suffix is not one. */
function seqFromKey(executionId: string, key: string): number | null {
  const prefix = stepLedgerPrefix(executionId);
  if (!key.startsWith(prefix)) {
    return null;
  }
  const seq = Number(key.slice(prefix.length));
  return Number.isInteger(seq) && seq >= 0 ? seq : null;
}

export function createStepLedgerStore(opts: { storage: StorageAdapter }): StepLedgerStore {
  const { storage } = opts;
  return {
    append: async (executionId, seq, entry) => {
      await storage.set(seqKey(executionId, seq), entry);
    },
    delete: async (executionId, seq) => {
      await storage.delete(seqKey(executionId, seq));
    },
    load: async (executionId) => {
      const keys = await storage.list(stepLedgerPrefix(executionId));
      /* One batch read, not one round trip per completed step. Recovery is the
       * moment a network-backed adapter can least afford an N+1. */
      const raws = await storageGetMany<unknown>(storage, keys);
      const entries = new Map<string, StepLedgerEntry>();
      /* The next sequence number comes from the KEYS, not the parsed rows: a row that
       * fails to parse still occupies its key, so it must not be handed back out. */
      let highestSeq = -1;
      const seqs = new Map<string, number>();
      // Walk the keys sorted: `seqKey`'s zero-padding makes key order dispatch order,
      // and a later entry at a path must win over an earlier one.
      for (const key of [
        ...keys,
      ].sort()) {
        const seq = seqFromKey(executionId, key);
        if (seq !== null) {
          highestSeq = Math.max(highestSeq, seq);
        }
        const raw = raws.get(key);
        if (raw === undefined || seq === null) {
          continue;
        }
        const parsed = StepLedgerEntrySchema.safeParse(raw);
        if (!parsed.success) {
          /* A row we cannot read is a step we cannot replay — it simply re-runs.
           * Dropping it is safe; failing the resume over it would not be. */
          console.warn(`StepLedger: discarding unreadable entry "${key}": ${parsed.error.message}`);
          continue;
        }
        entries.set(parsed.data.path, parsed.data);
        seqs.set(parsed.data.path, seq);
      }
      return {
        entries,
        seqs,
        nextSeq: highestSeq + 1,
      };
    },
    clear: async (executionId) => {
      const keys = await storage.list(stepLedgerPrefix(executionId));
      for (const key of keys) {
        await storage.delete(key);
      }
    },
  };
}

//#endregion

//#region Ledger

/** @public What retention did to one execution's ledger. Observable for host logging. */
export interface StepLedgerStats {
  /** Entries written. */
  recorded: number;
  /** Entries not written because their output exceeded `maxEntryBytes`. */
  droppedOversize: number;
  /** Entries not written because their output does not survive JSON encoding. */
  droppedUnserialisable: number;
  /** Entries not written because `maxEntries` were already live. */
  droppedFull: number;
  /** Entries deleted because a parent above them recorded. */
  pruned: number;
}

/** What a recorded step leaves for replay: the step's identity and input hash. */
export interface StepLedgerMatch {
  id: string;
  kind: string;
  inputHash: string | undefined;
}

/**
 * @public
 * The in-memory ledger a single execution carries: entries recovered from a previous
 * run (available for replay) plus the sequence counter for newly recorded ones.
 *
 * Shared by reference across inParallel/spawn children so one execution has one ledger —
 * path keys are globally unique across the step tree, so a flat map is correct. That
 * sharing is also why retention lives here rather than in the store: the live set that
 * the entry cap counts belongs to the execution, not to the harness.
 */
export class StepLedger {
  /** Recovered entries, by path. */
  private readonly replayable = new Map<string, StepLedgerEntry>();
  /** Sequence number holding each live entry, recovered or recorded, by path. */
  private readonly live = new LiveEntries();
  /** Sequence number the next recorded entry takes. */
  private seq: number;
  private readonly store?: StepLedgerStore;
  private readonly executionId: string;
  private readonly retention: Required<StepLedgerRetention>;
  private readonly counts: StepLedgerStats = {
    recorded: 0,
    droppedOversize: 0,
    droppedUnserialisable: 0,
    droppedFull: 0,
    pruned: 0,
  };

  constructor(opts: {
    executionId: string;
    store?: StepLedgerStore;
    /** What `StepLedgerStore.load` recovered. Absent on a fresh execution. */
    recovered?: StepLedgerWindow;
    retention?: StepLedgerRetention;
  }) {
    this.executionId = opts.executionId;
    this.store = opts.store;
    this.retention = resolveStepLedgerRetention(opts.retention);
    this.seq = 0;
    if (opts.recovered) {
      this.adopt(opts.recovered);
    }
  }

  /**
   * Take what storage now holds for this execution in place of what this ledger has
   * in memory — for a run retried in place, which replays what was stored.
   */
  adopt(recovered: StepLedgerWindow): void {
    this.replayable.clear();
    for (const [path, entry] of recovered.entries) {
      this.replayable.set(path, entry);
    }
    this.live.clear();
    for (const [path, seq] of recovered.seqs) {
      this.live.set(path, seq);
    }
    this.seq = Math.max(this.seq, recovered.nextSeq);
  }

  /** True when this execution has nothing recovered to replay (the common, fresh case). */
  get isEmpty(): boolean {
    return this.replayable.size === 0;
  }

  /** What retention has done so far. A snapshot — safe to hold. */
  get stats(): StepLedgerStats {
    return {
      ...this.counts,
    };
  }

  /**
   * The recorded entry for `path`, when a previous run completed the same step there on
   * the same input. A divergence — a different step id, kind, or input — returns
   * undefined so the step runs fresh. At a positional path it also discards every entry
   * recorded beneath it: the subtree's outputs belong to a run that no longer exists. A
   * `key:` entry discards only itself: nothing is nested under a content key.
   *
   * An entry recorded without an input hash matches on identity alone.
   */
  take(path: string, step: StepLedgerMatch): StepLedgerEntry | undefined {
    const entry = this.replayable.get(path);
    if (!entry) {
      return undefined;
    }
    if (matches(entry, step)) {
      return entry;
    }
    if (path.startsWith(REPLAY_KEY_PREFIX)) {
      this.replayable.delete(path);
      return undefined;
    }
    for (const key of [
      ...this.replayable.keys(),
    ]) {
      if (key === path || isBeneath(key, path)) {
        this.replayable.delete(key);
      }
    }
    return undefined;
  }

  /**
   * Record a completed step, then prune what it makes dead: a resumed run replays this
   * entry without descending, so nothing recorded beneath it will be read again.
   * Best-effort: a failed write costs resumability, not the run.
   */
  async record(entry: StepLedgerEntry): Promise<void> {
    if (!this.store) {
      return;
    }
    if (!this.retainable(entry)) {
      return;
    }
    /* Reserve the sequence number BEFORE awaiting: concurrent inParallel legs record through
     * the one shared ledger, and two of them reading the same counter would write the
     * same key, silently overwriting a sibling's entry. */
    const seq = this.seq;
    this.seq = seq + 1;
    try {
      await this.store.append(this.executionId, seq, entry);
    } catch (error) {
      console.warn(
        `StepLedger: failed to record "${entry.path}":`,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const replaced = this.live.get(entry.path);
    this.live.set(entry.path, seq);
    this.counts.recorded += 1;
    if (replaced !== undefined) {
      await this.deleteSeq(replaced);
    }
    if (!entry.path.startsWith(REPLAY_KEY_PREFIX)) {
      await this.prune(this.live.beneath(entry.path));
    }
  }

  /**
   * Drop every positional entry. A host calls this once a run has finished and the
   * checkpoint holds its result: every later resume starts past them, so they are dead.
   * `key:` entries stay — they are keyed by content, and a later run may ask the same.
   */
  async dropPaths(): Promise<void> {
    await this.prune(this.live.paths().filter((path) => !path.startsWith(REPLAY_KEY_PREFIX)));
    for (const path of [
      ...this.replayable.keys(),
    ]) {
      if (!path.startsWith(REPLAY_KEY_PREFIX)) {
        this.replayable.delete(path);
      }
    }
  }

  private async prune(dead: ReadonlyArray<string>): Promise<void> {
    for (const path of dead) {
      const seq = this.live.get(path);
      if (seq === undefined) {
        continue;
      }
      this.live.delete(path);
      this.replayable.delete(path);
      this.counts.pruned += 1;
      await this.deleteSeq(seq);
    }
  }

  private async deleteSeq(seq: number): Promise<void> {
    try {
      await this.store?.delete(this.executionId, seq);
    } catch (error) {
      console.warn(
        `StepLedger: failed to delete entry ${seq} of "${this.executionId}":`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Whether this entry is small enough, encodable, and within the live cap. An entry
   * that fails any test is not recorded, so its step re-runs on resume.
   */
  private retainable(entry: StepLedgerEntry): boolean {
    if (!this.live.has(entry.path) && this.liveAfter(entry.path) >= this.retention.maxEntries) {
      this.counts.droppedFull += 1;
      this.warnOnFirstDrop(
        this.counts.droppedFull,
        `StepLedger: not recording "${entry.path}" — ${this.retention.maxEntries} entries (maxEntries) are already live.`,
      );
      return false;
    }
    let bytes: string;
    try {
      // `undefined` stringifies to nothing; there is no size to bound.
      bytes =
        (JSON.stringify(entry.output) ?? '') + (entry.items ? JSON.stringify(entry.items) : '');
    } catch {
      this.counts.droppedUnserialisable += 1;
      this.warnOnFirstDrop(
        this.counts.droppedUnserialisable,
        `StepLedger: not recording "${entry.path}" — its output does not survive JSON encoding.`,
      );
      return false;
    }
    if (!fitsByteCap(bytes, this.retention.maxEntryBytes)) {
      this.counts.droppedOversize += 1;
      this.warnOnFirstDrop(
        this.counts.droppedOversize,
        `StepLedger: not recording "${entry.path}" — output and items exceed maxEntryBytes (${this.retention.maxEntryBytes}).`,
      );
      return false;
    }
    return true;
  }

  /** Live entries once recording at `path` has pruned what lies beneath it. */
  private liveAfter(path: string): number {
    if (this.live.size < this.retention.maxEntries || path.startsWith(REPLAY_KEY_PREFIX)) {
      return this.live.size;
    }
    return this.live.size - this.live.beneath(path).length;
  }

  /** One warning per reason per execution — a long run would otherwise flood the log. */
  private warnOnFirstDrop(count: number, message: string): void {
    if (count > 1) {
      return;
    }
    console.warn(`${message} The step will re-run on resume; further drops are silent.`);
  }
}

function matches(entry: StepLedgerEntry, step: StepLedgerMatch): boolean {
  if (entry.stepId !== step.id || entry.kind !== step.kind) {
    return false;
  }
  return entry.inputHash === undefined || entry.inputHash === step.inputHash;
}

/** Whether `path` lies in the subtree under `parent` — a lane below it or a child context's prefix. */
function isBeneath(path: string, parent: string): boolean {
  return path.startsWith(`${parent}/`) || path.startsWith(`${parent}[`);
}

/**
 * Live entries by path, with the paths also kept sorted. Everything beneath a path
 * starts with `<path>/` or `<path>[`, so in sorted order each is one contiguous run,
 * found by binary search. Scanning every live entry instead made each record cost the
 * whole live set — in deep recursion, where the live set and the paths both grow with
 * depth, that was cubic.
 */
class LiveEntries {
  private readonly seqs = new Map<string, number>();
  private readonly sorted: string[] = [];

  get size(): number {
    return this.seqs.size;
  }

  get(path: string): number | undefined {
    return this.seqs.get(path);
  }

  has(path: string): boolean {
    return this.seqs.has(path);
  }

  set(path: string, seq: number): void {
    if (!this.seqs.has(path)) {
      this.sorted.splice(lowerBound(this.sorted, path), 0, path);
    }
    this.seqs.set(path, seq);
  }

  delete(path: string): void {
    if (!this.seqs.delete(path)) {
      return;
    }
    this.sorted.splice(lowerBound(this.sorted, path), 1);
  }

  clear(): void {
    this.seqs.clear();
    this.sorted.length = 0;
  }

  paths(): string[] {
    return [
      ...this.sorted,
    ];
  }

  /** Every live path beneath `parent`. */
  beneath(parent: string): string[] {
    const found: string[] = [];
    for (const prefix of [
      `${parent}/`,
      `${parent}[`,
    ]) {
      for (let i = lowerBound(this.sorted, prefix); i < this.sorted.length; i++) {
        const path = this.sorted[i];
        if (!path?.startsWith(prefix)) {
          break;
        }
        found.push(path);
      }
    }
    return found;
  }
}

/** Index of the first element of sorted `list` not less than `value`. */
function lowerBound(list: ReadonlyArray<string>, value: string): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((list[mid] ?? '') < value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

//#endregion
