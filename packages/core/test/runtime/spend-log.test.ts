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

    expect((await log.get('a'))?.model).toBe('acme/model');
    await log.remove('a');
    expect(await log.get('a')).toBeUndefined();
    expect(await log.list()).toEqual([]);
  });

  it('skips a record it cannot read', async () => {
    const storage = createInMemoryStorage();
    const log = createSpendLog(storage);
    await storage.set('spend:broken', {
      id: 'broken',
    });
    await log.put(record('a', '2026-01-01T00:00:00.000Z'));

    expect((await log.list()).map((r) => r.id)).toEqual([
      'a',
    ]);
    expect(await log.get('broken')).toBeUndefined();
  });
});
