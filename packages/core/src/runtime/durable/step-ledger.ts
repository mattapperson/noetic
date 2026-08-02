/**
 * The step completion ledger: what a resumed execution replays instead of re-running.
 *
 * The frontier records which steps were IN FLIGHT at snapshot time; it says nothing
 * about which ones finished, and a finished step leaves no trace once `leaveStep` pops
 * it. Resume therefore needs a separate record — and it must carry each step's OUTPUT,
 * not merely a "done" flag: steps consume the previous step's value, and an `llm` step
 * re-run to catch up produces a different one than the rest of the run already saw.
 *
 * Entries are stored one key per step so appends are O(1). Folding the whole ledger
 * into the single `execution:<id>:snapshot` key would rewrite a growing blob on every
 * step — O(n²) bytes over a run.
 *
 * Sharding bounds the cost of one append but not the total, so retention is bounded on
 * two axes (`StepLedgerRetention`): an oversized entry is dropped rather than written,
 * and past `maxEntries` the oldest entry is evicted. Both degradations are safe by
 * construction — a missing entry re-runs its step, which costs work rather than
 * correctness.
 */

import type { StorageAdapter } from '@noetic-tools/context';
import { storageGetMany } from '@noetic-tools/context';
import { NoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';

//#region Entry

/** @public One completed step, keyed by its execution path. */
export const StepLedgerEntrySchema = z.object({
  /** Execution path key — see `ContextImpl.currentPath()`. Unique per dispatch. */
  path: z.string().min(1),
  stepId: z.string(),
  kind: z.string(),
  /** Replayed verbatim in place of re-running the step. */
  output: z.unknown(),
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
   * Largest output, in UTF-8 bytes of its JSON encoding, that will be recorded. A step
   * whose output exceeds this is not recorded at all and re-runs on resume. Keeps one
   * entry inside the per-value limit real storage backends impose (128 KiB on several)
   * instead of failing the write. Pass `Infinity` to record any size.
   *
   * Defaults to `DEFAULT_STEP_LEDGER_RETENTION.maxEntryBytes` (128 KiB).
   */
  maxEntryBytes?: number;
  /**
   * Most entries retained for one execution. Recording past the cap evicts the oldest
   * entry, so resume is best-effort over a bounded *suffix* of the run: the tail of the
   * work is skipped, the head runs again. Pass `Infinity` to retain every entry.
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

//#region Store

/** Storage key prefix owning every ledger entry for one execution. */
export function stepLedgerPrefix(executionId: string): string {
  return `execution:${executionId}:ledger:`;
}

/**
 * @public
 * Everything one execution's ledger recovered from storage: the entries available for
 * replay plus the sequence bookkeeping a further append needs. `nextSeq` cannot be
 * derived from `entries.size` — retention leaves gaps, and reusing a live sequence
 * number would overwrite an entry the resumed run still has to replay.
 */
export interface StepLedgerWindow {
  /** Recovered entries, keyed by execution path. Corrupt rows are skipped. */
  entries: Map<string, StepLedgerEntry>;
  /** Sequence number the next append takes: highest recorded, plus one. */
  nextSeq: number;
  /** Lowest sequence number still in storage — where eviction resumes. */
  oldestSeq: number;
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
      /* Sequence bounds come from the KEYS, not the parsed rows: a row that fails to
       * parse still occupies its key, so it must not be handed back out as reusable. */
      let highestSeq = -1;
      let oldestSeq = -1;
      // Walk `keys`, not the map: `seqKey`'s zero-padding makes `list()` order
      // dispatch order, and a later entry at a path must win over an earlier one.
      for (const key of keys) {
        const seq = seqFromKey(executionId, key);
        if (seq !== null) {
          highestSeq = Math.max(highestSeq, seq);
          oldestSeq = oldestSeq === -1 ? seq : Math.min(oldestSeq, seq);
        }
        const raw = raws.get(key);
        if (raw === undefined) {
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
      }
      return {
        entries,
        nextSeq: highestSeq + 1,
        oldestSeq: oldestSeq === -1 ? 0 : oldestSeq,
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
  /** Entries deleted to stay within `maxEntries`. */
  evicted: number;
}

/**
 * @public
 * The in-memory ledger a single execution carries: entries recovered from a previous
 * run (available for replay) plus the sequence counter for newly recorded ones.
 *
 * Shared by reference across fork/spawn children so one execution has one ledger —
 * path keys are globally unique across the step tree, so a flat map is correct. That
 * sharing is also why retention lives here rather than in the store: the sequence
 * cursor eviction walks belongs to the execution, not to the harness.
 */
export class StepLedger {
  /** Recovered entries, by path. Consumed as replay proceeds. */
  private readonly replayable: Map<string, StepLedgerEntry>;
  /** Sequence number the next recorded entry takes. */
  private seq: number;
  /** Lowest sequence number still in storage — advances as eviction proceeds. */
  private oldestSeq: number;
  private readonly store?: StepLedgerStore;
  private readonly executionId: string;
  private readonly retention: Required<StepLedgerRetention>;
  private readonly counts: StepLedgerStats = {
    recorded: 0,
    droppedOversize: 0,
    droppedUnserialisable: 0,
    evicted: 0,
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
    this.replayable = opts.recovered?.entries ?? new Map();
    this.seq = opts.recovered?.nextSeq ?? 0;
    this.oldestSeq = opts.recovered?.oldestSeq ?? 0;
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
   * The recorded output for `path`, when a previous run completed the same step there.
   * A divergence (different step id or kind at this path) discards the entry and every
   * entry recorded beneath it, then returns undefined so the step runs fresh — the
   * subtree's recorded outputs belong to a branch that no longer exists.
   */
  take(
    path: string,
    step: {
      id: string;
      kind: string;
    },
  ): StepLedgerEntry | undefined {
    const entry = this.replayable.get(path);
    if (!entry) {
      return undefined;
    }
    if (entry.stepId !== step.id || entry.kind !== step.kind) {
      this.discardSubtree(path);
      return undefined;
    }
    return entry;
  }

  /** Drop `path` and everything recorded below it. */
  private discardSubtree(path: string): void {
    for (const key of [
      ...this.replayable.keys(),
    ]) {
      if (key === path || key.startsWith(`${path}/`)) {
        this.replayable.delete(key);
      }
    }
  }

  /** Record a completed step. Best-effort: a failed write costs resumability, not the run. */
  async record(entry: StepLedgerEntry): Promise<void> {
    if (!this.store) {
      return;
    }
    if (!this.retainable(entry)) {
      return;
    }
    /* Reserve the sequence number BEFORE awaiting: concurrent fork legs record through
     * the one shared ledger, and two of them reading the same counter would write the
     * same key, silently overwriting a sibling's entry. A write that then fails leaves a
     * gap, which only makes the window below a slight over-estimate of the live count —
     * eviction runs marginally early, never late. */
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
    this.counts.recorded += 1;
    await this.evictOverflow();
  }

  /**
   * Whether this entry is small enough — and encodable at all — to be worth a write.
   * An output no adapter could serialise is treated exactly like an oversized one:
   * not recorded, so the step re-runs.
   */
  private retainable(entry: StepLedgerEntry): boolean {
    let json: string | undefined;
    try {
      json = JSON.stringify(entry.output);
    } catch {
      this.counts.droppedUnserialisable += 1;
      this.warnOnFirstDrop(
        this.counts.droppedUnserialisable,
        `StepLedger: not recording "${entry.path}" — its output does not survive JSON encoding.`,
      );
      return false;
    }
    // `undefined` stringifies to nothing; there is no size to bound.
    if (json !== undefined && !fitsByteCap(json, this.retention.maxEntryBytes)) {
      this.counts.droppedOversize += 1;
      this.warnOnFirstDrop(
        this.counts.droppedOversize,
        `StepLedger: not recording "${entry.path}" — output exceeds maxEntryBytes (${this.retention.maxEntryBytes}).`,
      );
      return false;
    }
    return true;
  }

  /**
   * Delete oldest-first until the execution is back inside `maxEntries`. The bound is on
   * the sequence *window* rather than an exact row count, which is what keeps this
   * correct without a `list()` per append.
   */
  private async evictOverflow(): Promise<void> {
    const store = this.store;
    if (!store) {
      return;
    }
    while (this.seq - this.oldestSeq > this.retention.maxEntries) {
      const victim = this.oldestSeq;
      try {
        await store.delete(this.executionId, victim);
      } catch (error) {
        /* Leave the cursor where it is and stop: the next append retries this victim
         * rather than spinning on a store that is currently refusing deletes. */
        console.warn(
          `StepLedger: failed to evict entry ${victim} of "${this.executionId}":`,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      this.oldestSeq = victim + 1;
      this.counts.evicted += 1;
    }
  }

  /** One warning per reason per execution — a long run would otherwise flood the log. */
  private warnOnFirstDrop(count: number, message: string): void {
    if (count > 1) {
      return;
    }
    console.warn(`${message} The step will re-run on resume; further drops are silent.`);
  }
}

//#endregion
