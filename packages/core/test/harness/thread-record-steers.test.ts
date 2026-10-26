// Which steers a thread record keeps: from when a running turn accepts them until the
// turn ends, minus any the next turn takes as its input.

import { describe, expect, it } from 'bun:test';
import type { Context, Item } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { ThreadRecord } from '../../src/harness/thread-record';
import { createSessionStore } from '../../src/runtime/durable/session-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { QueuedMessage } from '../../src/runtime/message-queue';
import { makeMessage } from '../_helpers';

//#region Fixtures

function makeRecord(): ThreadRecord {
  return new ThreadRecord(
    {
      store: createSessionStore(createInMemoryStorage()),
      restore: async () => null,
      clearCheckpoint: async () => {},
      parseItems: (raw) => frameworkCast<Item[]>(raw),
    },
    't',
  );
}

function message(id: string, deliveryMode: QueuedMessage['deliveryMode']): QueuedMessage {
  return {
    id,
    input: id,
    deliveryMode,
    options: {},
    enqueuedAt: 1,
  };
}

const ctx = frameworkCast<Context>({
  id: 'exec-1',
});

//#endregion

describe('ThreadRecord steers', () => {
  it('keeps steers, but not messages for the next turn', async () => {
    const record = makeRecord();
    await record.keepSteer(message('a', 'between-rounds'));
    await record.keepSteer(message('b', 'next-turn'));
    await record.keepSteer(message('c', 'next-item'));
    await record.keepSteer(message('a', 'between-rounds'));

    expect(
      (await record.steers()).map((steer) => [
        steer.id,
        steer.deliveryMode,
      ]),
    ).toEqual([
      [
        'c',
        'next-item',
      ],
      [
        'a',
        'between-rounds',
      ],
    ]);
  });

  it('round-trips item input through storage', async () => {
    const record = makeRecord();
    const items = [
      makeMessage('developer', 'use staging', 'item-1'),
    ];
    await record.keepSteer({
      ...message('a', 'between-rounds'),
      input: items,
    });

    expect((await record.steers())[0]?.input).toEqual(items);
  });

  it('keeps only still-queued steers when the turn ends', async () => {
    const record = makeRecord();
    await record.keepSteer(message('applied', 'between-rounds'));
    await record.keepSteer(message('late', 'between-rounds'));

    await record.end(
      ctx,
      [],
      [
        'late',
      ],
    );

    expect((await record.steers()).map((steer) => steer.id)).toEqual([
      'late',
    ]);
  });

  it('drops a kept steer once a turn takes it as input', async () => {
    const record = makeRecord();
    await record.keepSteer(message('late', 'between-rounds'));
    await record.keepSteer(message('other', 'between-rounds'));

    await record.begin(ctx, [
      'late',
    ]);

    expect((await record.steers()).map((steer) => steer.id)).toEqual([
      'other',
    ]);
  });
});
