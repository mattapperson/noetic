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

//#endregion

//#region Helpers

/** How many times one write is tried before the failure is kept. */
const WRITE_ATTEMPTS = 3;
const WRITE_RETRY_MS = 10;

/** @internal The storage key a thread's display output is kept under. */
export function outputKey(scope: string): string {
  return `output:${scope}`;
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
 * snapshots stay queued, so the next call tries again.
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

  /** Fold one stream event into the output. Never throws: a failure waits for `flush`. */
  record(event: StreamEvent): void {
    try {
      for (const item of this.stream.push(event)) {
        this.queue(OutputSnapshotSchema.parse(item));
      }
    } catch (cause) {
      this.failure = this.error('Could not read a stream event as display output.', cause);
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
    return this.load();
  }

  /**
   * Wait until everything queued is saved.
   *
   * @throws OutputStoreError when it could not be. What was queued stays queued.
   */
  async flush(): Promise<void> {
    this.start();
    while (this.writing) {
      await this.writing;
    }
    const failure = this.failure;
    if (failure) {
      // Thrown once: what failed to save is still queued, and the next flush tries it.
      this.failure = undefined;
      throw failure;
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

  private async load(): Promise<OutputSnapshot[]> {
    try {
      return OutputSnapshotSchema.array().parse(
        (await this.storage.get<unknown>(outputKey(this.scope))) ?? [],
      );
    } catch (cause) {
      throw this.error('Could not read streamed output.', cause);
    }
  }

  /** Save what is queued over what is stored, until nothing is queued. */
  private async drain(): Promise<void> {
    const held = new Map(
      (await this.load()).map((item) => [
        keyOf(item),
        item,
      ]),
    );
    while (this.pending.size > 0) {
      const batch = new Map(this.pending);
      this.pending.clear();
      for (const [key, item] of batch) {
        held.set(key, item);
      }
      try {
        await this.save([
          ...held.values(),
        ]);
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

  private async save(items: OutputSnapshot[]): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.storage.set(outputKey(this.scope), items);
        return;
      } catch (cause) {
        if (attempt >= WRITE_ATTEMPTS) {
          throw this.error('Could not write streamed output.', cause);
        }
        await wait(WRITE_RETRY_MS);
      }
    }
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
