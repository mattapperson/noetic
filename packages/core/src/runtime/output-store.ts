import type { ItemSchemaRegistry, StorageAdapter, StreamEvent } from '@noetic-tools/types';
import { z } from 'zod';
import { ItemStream } from './session-streams';

//#region Types

const OutputSnapshotSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    isComplete: z.boolean().optional(),
  })
  .catchall(z.unknown());

/**
 * @public One item of a thread's display output: an item snapshot as the item
 * stream yields it, unfinished ones included (`isComplete: false`), or whatever
 * a protocol adapter saved in its place.
 */
export type OutputSnapshot = z.infer<typeof OutputSnapshotSchema>;

/**
 * @public A thread's display output could not be read or written. `scope` is the
 * thread id; `cause` is what storage, or the snapshot check, failed with.
 */
export class OutputStoreError extends Error {
  readonly scope: string;

  constructor(options: {
    scope: string;
    message: string;
    cause: unknown;
  }) {
    super(options.message, {
      cause: options.cause,
    });
    this.name = 'OutputStoreError';
    this.scope = options.scope;
  }
}

/** A thread's output as storage holds it. */
interface Stored {
  raw: unknown;
  items: OutputSnapshot[];
}

//#endregion

//#region Helpers

/** How many times one write is tried before the failure is kept. */
const WRITE_ATTEMPTS = 3;
/** How many times a write may lose to another writer before it is a failure. */
const SWAP_ATTEMPTS = 20;
const WRITE_RETRY_MS = 10;

/** @internal The prefix every thread's display output key starts with. */
export const OUTPUT_PREFIX = 'output:';

/** @internal The storage key a thread's display output is kept under. */
export function outputKey(scope: string): string {
  return `${OUTPUT_PREFIX}${scope}`;
}

/** What makes two snapshots the same item: its id, else its call, else its content. */
function keyOf(item: OutputSnapshot): string {
  if (typeof item.id === 'string') {
    return item.id;
  }
  if (typeof item.callId === 'string') {
    return `${item.type}:${item.callId}`;
  }
  return JSON.stringify(item);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

//#endregion

//#region OutputStore

/**
 * @public A thread's display output, kept in storage under `output:<scope>`:
 * the latest snapshot of every item its stream produced, including items that
 * never finished. It is for showing a thread again, in a new process or after a
 * failed run. Nothing resumes from it: checkpoints, the step ledger and the
 * model's history are stored apart and never read here.
 *
 * `record` and `write` queue snapshots and save them in the background, one
 * write at a time, each holding the whole output. `flush` and `read` wait for
 * what is queued and throw `OutputStoreError` when it could not be saved; the
 * snapshots stay queued, so the next call tries again. On storage with `swap` a
 * write never replaces what another store saved meanwhile.
 */
export class OutputStore {
  private readonly storage: StorageAdapter;
  private readonly scope: string;
  private readonly stream: ItemStream;
  private readonly pending = new Map<string, OutputSnapshot>();
  private writing?: Promise<void>;
  private failure?: OutputStoreError;

  constructor(storage: StorageAdapter, scope: string, schemas?: ItemSchemaRegistry) {
    this.storage = storage;
    this.scope = scope;
    this.stream = new ItemStream(schemas);
  }

  /**
   * Fold one stream event into the output. Never throws: an event that cannot be
   * read as display output is left out, with a warning, and the run goes on.
   */
  record(event: StreamEvent): void {
    try {
      for (const item of this.stream.push(event)) {
        this.queue(OutputSnapshotSchema.parse(item));
      }
    } catch (cause) {
      console.warn(
        `[noetic] left a stream event out of the display output of "${this.scope}":`,
        cause,
      );
      return;
    }
    this.start();
  }

  /**
   * Save display snapshots, each replacing the stored one with its id, and resolve
   * the whole stored output.
   *
   * @throws OutputStoreError when `items` are not snapshots, or storage fails.
   */
  async write(items: ReadonlyArray<unknown>): Promise<OutputSnapshot[]> {
    const parsed = OutputSnapshotSchema.array().safeParse(items);
    if (!parsed.success) {
      throw this.error('Could not read display snapshots.', parsed.error);
    }
    for (const item of parsed.data) {
      this.queue(item);
    }
    return this.read();
  }

  /**
   * The stored output, after everything queued is saved.
   *
   * @throws OutputStoreError when storage fails or holds something else.
   */
  async read(): Promise<OutputSnapshot[]> {
    await this.flush();
    return (await this.load()).items;
  }

  /**
   * Wait until everything queued is saved.
   *
   * @throws OutputStoreError when it could not be. What was queued stays queued,
   *   and every flush throws until a later one saves it.
   */
  async flush(): Promise<void> {
    this.start();
    while (this.writing) {
      await this.writing;
    }
    // Not cleared here: two callers waiting on one failed write are both told.
    if (this.failure) {
      throw this.failure;
    }
  }

  private queue(item: OutputSnapshot): void {
    this.pending.set(keyOf(item), structuredClone(item));
  }

  private start(): void {
    if (this.pending.size === 0 || this.writing) {
      return;
    }
    this.writing = this.drain().then(
      () => {
        this.failure = undefined;
        this.writing = undefined;
        this.start();
      },
      (cause: unknown) => {
        this.failure =
          cause instanceof OutputStoreError
            ? cause
            : this.error('Could not write streamed output.', cause);
        this.writing = undefined;
      },
    );
  }

  /** What storage holds under the key, as it is stored and as snapshots. */
  private async load(): Promise<Stored> {
    try {
      const raw = (await this.storage.get<unknown>(outputKey(this.scope))) ?? null;
      return {
        raw,
        items: OutputSnapshotSchema.array().parse(raw ?? []),
      };
    } catch (cause) {
      throw this.error('Could not read streamed output.', cause);
    }
  }

  /** Save what is queued over what is stored, until nothing is queued. */
  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      const batch = new Map(this.pending);
      this.pending.clear();
      try {
        await this.save(batch);
      } catch (cause) {
        // Put back what was not saved, behind anything newer queued meanwhile.
        for (const [key, item] of batch) {
          if (!this.pending.has(key)) {
            this.pending.set(key, item);
          }
        }
        throw cause;
      }
    }
  }

  private async save(batch: ReadonlyMap<string, OutputSnapshot>): Promise<void> {
    let lost = 0;
    for (let attempt = 1; ; ) {
      try {
        if (await this.saveOver(batch)) {
          return;
        }
      } catch (cause) {
        if (cause instanceof OutputStoreError) {
          throw cause;
        }
        if (attempt >= WRITE_ATTEMPTS) {
          throw this.error('Could not write streamed output.', cause);
        }
        attempt++;
        await wait(WRITE_RETRY_MS);
        continue;
      }
      // Another writer saved first: merge over what it wrote.
      lost++;
      if (lost >= SWAP_ATTEMPTS) {
        throw this.error(
          'Could not write streamed output.',
          new Error(`Lost to another writer ${lost} times.`),
        );
      }
    }
  }

  /**
   * Write `batch` over what is stored now. On storage with `swap` the write lands
   * only if nothing else was saved since the read, and false means it did not.
   */
  private async saveOver(batch: ReadonlyMap<string, OutputSnapshot>): Promise<boolean> {
    const stored = await this.load();
    const held = new Map(
      stored.items.map((item) => [
        keyOf(item),
        item,
      ]),
    );
    for (const [key, item] of batch) {
      held.set(key, item);
    }
    const next = [
      ...held.values(),
    ];
    const key = outputKey(this.scope);
    if (!this.storage.swap) {
      await this.storage.set(key, next);
      return true;
    }
    return this.storage.swap(key, stored.raw, next);
  }

  private error(message: string, cause: unknown): OutputStoreError {
    return new OutputStoreError({
      scope: this.scope,
      message,
      cause,
    });
  }
}

//#endregion
