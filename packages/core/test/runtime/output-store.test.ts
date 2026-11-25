// Display output: the item snapshots a thread streamed, kept in storage apart from
// checkpoints. See specs/08-runtime § Display output.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { ItemSchemaRegistry, StreamEvent } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { OutputStore, OutputStoreError } from '../../src/runtime/output-store';
import { ItemStream } from '../../src/runtime/session-streams';

//#region Fixtures

function sdk(type: string, data: Record<string, unknown>, outputIndex?: number): StreamEvent {
  return {
    source: 'sdk',
    type,
    data,
    outputIndex,
  };
}

function added(id: string, outputIndex?: number): StreamEvent {
  return sdk(
    'response.output_item.added',
    {
      item: {
        id,
        type: 'message',
      },
    },
    outputIndex,
  );
}

function delta(text: string, itemId?: string, outputIndex?: number): StreamEvent {
  return sdk(
    'response.output_text.delta',
    {
      delta: text,
      ...(itemId
        ? {
            itemId,
          }
        : {}),
    },
    outputIndex,
  );
}

function done(id: string, outputIndex?: number): StreamEvent {
  return sdk(
    'response.output_item.done',
    {
      item: {
        id,
        type: 'message',
      },
    },
    outputIndex,
  );
}

function appended(item: Record<string, unknown>): StreamEvent {
  return {
    source: 'framework',
    type: 'agent:item_appended',
    data: {
      item,
    },
  };
}

/** The text and completion of each snapshot, as `id=text` with `…` for unfinished. */
function textsOf(items: ReadonlyArray<object>): string[] {
  return items.map((entry) => {
    const item: Record<string, unknown> = {
      ...entry,
    };
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content.map((part: { text?: string }) => part.text ?? '').join('');
    return `${String(item.id)}=${text}${item.isComplete ? '' : '…'}`;
  });
}

/** What `event` yields, read at once: a snapshot shares its content parts with the fold. */
function seen(stream: ItemStream, event: StreamEvent): string[] {
  return textsOf([
    ...stream.push(event),
  ]);
}

/** A storage whose writes to `output:` keys fail while `failing.on`. */
function failingOutputs(
  storage: StorageAdapter,
  failing: {
    on: boolean;
    writes: number;
  },
): StorageAdapter {
  return {
    ...storage,
    get: (key) => storage.get(key),
    delete: (key) => storage.delete(key),
    list: (prefix) => storage.list(prefix),
    async set<T>(key: string, value: T): Promise<void> {
      if (key.startsWith('output:')) {
        failing.writes += 1;
        if (failing.on) {
          throw new Error('disk full');
        }
      }
      await storage.set(key, value);
    },
  };
}

async function thrownBy(run: () => Promise<unknown>): Promise<OutputStoreError> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof OutputStoreError);
    return error;
  }
  return expect.unreachable('nothing was thrown');
}

//#endregion

describe('ItemStream', () => {
  it('matches an event that names its item by that id, across model calls running at once', () => {
    const stream = new ItemStream();
    const snapshots = [
      // Two calls stream at once, each with its item at output index 0.
      sdk('response.created', {}),
      added('msg_a', 0),
      sdk('response.created', {}),
      added('msg_b', 0),
      delta('A1', 'msg_a', 0),
      delta('B1', 'msg_b', 0),
      delta('A2', 'msg_a', 0),
      done('msg_a', 0),
    ].flatMap((event) => seen(stream, event));

    expect(snapshots).toEqual([
      'msg_a=…',
      'msg_b=…',
      'msg_a=A1…',
      'msg_b=B1…',
      'msg_a=A1A2…',
      'msg_a=A1A2',
    ]);
  });

  it('matches an event that names no item by round and output index', () => {
    const stream = new ItemStream();
    const snapshots = [
      sdk('response.created', {}),
      added('msg_1', 0),
      delta('one', undefined, 0),
      sdk('response.created', {}),
      added('msg_2', 0),
      delta('two', undefined, 0),
    ].flatMap((event) => seen(stream, event));

    expect(snapshots.at(-1)).toBe('msg_2=two…');
  });

  it('gives an event naming an unknown item, at no output index, to no item', () => {
    const stream = new ItemStream();
    const snapshots = [
      sdk('response.created', {}),
      added('msg_1', 0),
      delta('stray', 'msg_other'),
    ].flatMap((event) => seen(stream, event));

    expect(snapshots).toEqual([
      'msg_1=…',
    ]);
  });

  it('matches an item renamed after it was added by its output index', () => {
    const stream = new ItemStream();
    const snapshots = [
      sdk('response.created', {}),
      sdk(
        'response.output_item.added',
        {
          item: {
            type: 'message',
          },
        },
        0,
      ),
      delta('hi', 'msg_real', 0),
      done('msg_real', 0),
    ].flatMap((event) => seen(stream, event));

    expect(snapshots).toHaveLength(3);
    expect(snapshots.at(-1)).toEndWith('=hi');
  });
});

describe('OutputStore', () => {
  it('keeps the latest snapshot of each item, unfinished ones included', async () => {
    const storage = createInMemoryStorage();
    const output = new OutputStore(storage, 't');
    output.record(
      appended({
        id: 'u1',
        type: 'message',
        role: 'user',
        content: [],
      }),
    );
    output.record(sdk('response.created', {}));
    output.record(added('msg_1', 0));
    output.record(delta('half an ans', 'msg_1', 0));
    await output.flush();

    // Another store over the same storage, as a new process has.
    const later = await new OutputStore(storage, 't').read();
    expect(textsOf(later)).toEqual([
      'u1=',
      'msg_1=half an ans…',
    ]);
    // Kept under its own key, apart from everything else in storage.
    expect(await storage.list('')).toEqual([
      'output:t',
    ]);
  });

  it('replaces a snapshot when its item changes, and adds to what an earlier store saved', async () => {
    const storage = createInMemoryStorage();
    const first = new OutputStore(storage, 't');
    first.record(sdk('response.created', {}));
    first.record(added('msg_1', 0));
    first.record(delta('hello', 'msg_1', 0));
    first.record(done('msg_1', 0));
    await first.flush();

    const second = new OutputStore(storage, 't');
    second.record(sdk('response.created', {}));
    second.record(added('msg_2', 0));
    expect(textsOf(await second.read())).toEqual([
      'msg_1=hello',
      'msg_2=…',
    ]);
  });

  it('keeps threads apart', async () => {
    const storage = createInMemoryStorage();
    const a = new OutputStore(storage, 'a');
    a.record(
      appended({
        id: 'u1',
        type: 'message',
      }),
    );
    await a.flush();
    expect(await new OutputStore(storage, 'b').read()).toEqual([]);
  });

  it('write() saves snapshots by id and returns the whole output', async () => {
    const output = new OutputStore(createInMemoryStorage(), 't');
    await output.write([
      {
        id: 'x',
        type: 'acp:plan',
        steps: 1,
      },
      {
        type: 'function_call_output',
        callId: 'c1',
        output: 'a',
      },
    ]);
    const all = await output.write([
      {
        id: 'x',
        type: 'acp:plan',
        steps: 2,
      },
      {
        type: 'function_call_output',
        callId: 'c1',
        output: 'b',
      },
    ]);
    expect(all).toEqual([
      {
        id: 'x',
        type: 'acp:plan',
        steps: 2,
      },
      {
        type: 'function_call_output',
        callId: 'c1',
        output: 'b',
      },
    ]);
  });

  it('write() refuses what is not a snapshot, and saves none of it', async () => {
    const output = new OutputStore(createInMemoryStorage(), 't');
    const error = await thrownBy(() =>
      output.write([
        {
          id: 'ok',
          type: 'message',
        },
        {
          id: 'no-type',
        },
      ]),
    );
    expect(error.name).toBe('OutputStoreError');
    expect(error.scope).toBe('t');
    expect(error.message).toBe('Could not read display snapshots.');
    expect(await output.read()).toEqual([]);
  });

  it('read() refuses stored data that is not display output', async () => {
    const storage = createInMemoryStorage();
    await storage.set('output:t', {
      not: 'a list',
    });
    const error = await thrownBy(() => new OutputStore(storage, 't').read());
    expect(error.message).toBe('Could not read streamed output.');
    expect(error.cause).toBeDefined();
  });

  it('tries a failed write three times, then fails the flush and keeps what was queued', async () => {
    const failing = {
      on: true,
      writes: 0,
    };
    const storage = createInMemoryStorage();
    const output = new OutputStore(failingOutputs(storage, failing), 't');
    output.record(
      appended({
        id: 'u1',
        type: 'message',
      }),
    );
    const error = await thrownBy(() => output.flush());
    expect(error.message).toBe('Could not write streamed output.');
    expect(error.cause).toEqual(new Error('disk full'));
    expect(failing.writes).toBe(3);

    // Storage comes back: the next flush saves what the failed one could not.
    failing.on = false;
    await output.flush();
    expect(await storage.get('output:t')).toEqual([
      {
        id: 'u1',
        type: 'message',
        isComplete: true,
      },
    ]);
  });

  it('a write that fails twice and then lands is not a failure', async () => {
    const failing = {
      on: true,
      writes: 0,
    };
    const storage = createInMemoryStorage();
    const flaky = failingOutputs(storage, failing);
    const set = flaky.set.bind(flaky);
    flaky.set = async (key, value) => {
      failing.on = failing.writes < 2;
      await set(key, value);
    };
    const output = new OutputStore(flaky, 't');
    output.record(
      appended({
        id: 'u1',
        type: 'message',
      }),
    );
    await output.flush();
    expect(failing.writes).toBe(3);
    expect(await storage.get('output:t')).toHaveLength(1);
  });

  it('record() never throws: an event it cannot fold is left out, and the flush succeeds', async () => {
    const storage = createInMemoryStorage();
    const output = new OutputStore(
      storage,
      't',
      frameworkCast<ItemSchemaRegistry>({
        parse: () => {
          throw new Error('unknown item');
        },
      }),
    );
    output.record(
      sdk('response.output_item.added', {
        item: {
          id: 'x',
          type: 'mystery',
        },
      }),
    );
    await output.flush();
    expect(await storage.get('output:t')).toBeNull();
  });

  it('tells every flush waiting on a failed write, until a later one lands', async () => {
    const failing = {
      on: true,
      writes: 0,
    };
    const output = new OutputStore(failingOutputs(createInMemoryStorage(), failing), 't');
    output.record(
      appended({
        id: 'u1',
        type: 'message',
      }),
    );
    const settled = await Promise.allSettled([
      output.flush(),
      output.flush(),
    ]);
    expect(settled.map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
    ]);
    await expect(output.flush()).rejects.toBeInstanceOf(OutputStoreError);
    failing.on = false;
    await output.flush();
  });

  it('never replaces what another store saved meanwhile, on storage with swap', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const slow: StorageAdapter = {
      ...storage,
      async get<T>(key: string): Promise<T | null> {
        const value = await storage.get<T>(key);
        // Read before the other store's write, and swap after it.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return value;
      },
    };
    const first = new OutputStore(slow, 't');
    const second = new OutputStore(storage, 't');
    first.record(
      appended({
        id: 'a',
        type: 'message',
      }),
    );
    second.record(
      appended({
        id: 'b',
        type: 'message',
      }),
    );
    await Promise.all([
      first.flush(),
      second.flush(),
    ]);
    const stored =
      await storage.get<
        {
          id: string;
        }[]
      >('output:t');
    assert(stored);
    expect(stored.map((item) => item.id).sort()).toEqual([
      'a',
      'b',
    ]);
  });
});
