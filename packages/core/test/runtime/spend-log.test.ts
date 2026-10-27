import { describe, expect, it } from 'bun:test';
import { createSpendLog } from '../../src/runtime/durable/spend-log';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';

function record(id: string, sentAt: string) {
  return {
    id,
    kind: 'model' as const,
    model: 'acme/model',
    requestHash: 'h',
    inputTokens: 1,
    sentAt,
  };
}

describe('spend log', () => {
  it('lists records oldest first under its own prefix, apart from checkpoints', async () => {
    const storage = createInMemoryStorage();
    const log = createSpendLog(storage);
    await log.put(record('b', '2026-01-02T00:00:00.000Z'));
    await log.put(record('a', '2026-01-01T00:00:00.000Z'));

    expect((await log.list()).map((r) => r.id)).toEqual([
      'a',
      'b',
    ]);
    expect(await storage.list('spend:')).toHaveLength(2);
    expect(await storage.list('execution:')).toEqual([]);
  });

  it('gets and removes one record', async () => {
    const log = createSpendLog(createInMemoryStorage());
    await log.put(record('a', '2026-01-01T00:00:00.000Z'));

    expect(await log.get('a')).toMatchObject({
      model: 'acme/model',
    });
    await log.remove('a');
    expect(await log.get('a')).toBeUndefined();
    expect(await log.list()).toEqual([]);
  });

  it('keeps a record it cannot read, listed first with the owner it still names', async () => {
    const storage = createInMemoryStorage();
    const log = createSpendLog(storage);
    await log.put(record('a', '2026-01-01T00:00:00.000Z'));
    await storage.set('spend:torn', {
      id: 'torn',
      executionId: 'exec-1',
      threadId: 42,
    });
    await storage.set('spend:garbage', 'not a record');

    const listed = await log.list();

    expect(
      listed
        .slice(0, 2)
        .map((r) => r.id)
        .sort(),
    ).toEqual([
      'garbage',
      'torn',
    ]);
    expect(listed[2]?.id).toBe('a');
    expect(await log.get('torn')).toEqual({
      id: 'torn',
      unreadable: true,
      executionId: 'exec-1',
    });
    expect(await log.get('garbage')).toEqual({
      id: 'garbage',
      unreadable: true,
    });
    expect(await log.get('missing')).toBeUndefined();
  });
});

describe('a store that reads a damaged value as nothing', () => {
  /** Like `createFileStorage`: a key that does not parse still lists, but reads as null. */
  function damaging(damaged: string) {
    const storage = createInMemoryStorage();
    return {
      storage: {
        ...storage,
        get: async <T>(key: string) => (key === damaged ? null : storage.get<T>(key)),
        getMany: undefined,
      },
      inner: storage,
    };
  }

  it('still keeps the record while its key lists', async () => {
    const { storage, inner } = damaging('spend:torn');
    await inner.set('spend:torn', '{"id":"to');
    const log = createSpendLog(storage);

    expect(await log.list()).toEqual([
      {
        id: 'torn',
        unreadable: true,
      },
    ]);
    expect(await log.get('torn')).toEqual({
      id: 'torn',
      unreadable: true,
    });
    await log.remove('torn');
    expect(await log.list()).toEqual([]);
    expect(await log.get('torn')).toBeUndefined();
  });

  it('does not take a key deleted mid-read for a damaged one', async () => {
    const inner = createInMemoryStorage();
    const log = createSpendLog({
      ...inner,
      getMany: undefined,
      get: async <T>(key: string) => {
        await inner.delete(key);
        return inner.get<T>(key);
      },
    });
    await log.put(record('a', '2026-01-01T00:00:00.000Z'));

    expect(await log.list()).toEqual([]);
  });

  it('does not take a key that shares the prefix for the one asked', async () => {
    const { storage, inner } = damaging('spend:a');
    await inner.set('spend:ab', record('ab', '2026-01-01T00:00:00.000Z'));
    const log = createSpendLog(storage);

    expect(await log.get('a')).toBeUndefined();
  });
});
