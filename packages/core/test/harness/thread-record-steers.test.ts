// Which steers a thread record keeps: from when a running turn accepts them until the
// turn ends, minus any the next turn takes as its input.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { Context, Item } from '@noetic-tools/types';
import { frameworkCast, NoeticErrorImpl } from '@noetic-tools/types';
import { ThreadRecord } from '../../src/harness/thread-record';
import { createSessionStore } from '../../src/runtime/durable/session-store';
import type { LedgerFence } from '../../src/runtime/durable/turn-lease';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { QueuedMessage } from '../../src/runtime/message-queue';
import { makeMessage } from '../_helpers';

//#region Fixtures

function makeRecord(storage = createInMemoryStorage()): ThreadRecord {
  return new ThreadRecord(
    {
      store: createSessionStore(storage),
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

/** A turn on a flow with no version and no source. */
const NO_FLOW = {
  version: undefined,
  stored: undefined,
};

const ctx = frameworkCast<Context>({
  id: 'exec-1',
});

/** A fence at a fixed term, as a turn lease gives the record. */
function fenceAt(term: number): LedgerFence {
  return {
    term,
    assert: () => {},
    verify: async () => {},
    lose: (reason) =>
      new NoeticErrorImpl({
        kind: 'lease_lost',
        executionId: ctx.id,
        term,
        reason,
      }),
  };
}

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

    await record.end(ctx, {
      history: [],
      queuedIds: [
        'late',
      ],
    });

    expect((await record.steers()).map((steer) => steer.id)).toEqual([
      'late',
    ]);
  });

  it('drops a kept steer once a turn takes it as input', async () => {
    const record = makeRecord();
    await record.keepSteer(message('late', 'between-rounds'));
    await record.keepSteer(message('other', 'between-rounds'));

    await record.begin(
      ctx,
      [
        'late',
      ],
      NO_FLOW,
    );

    expect((await record.steers()).map((steer) => steer.id)).toEqual([
      'other',
    ]);
  });

  it('removes the kept steers a turn drops in the write that records it', async () => {
    const record = makeRecord();
    await record.keepSteer(message('gone', 'between-rounds'));
    await record.keepSteer(message('input', 'between-rounds'));
    await record.keepSteer(message('stays', 'between-rounds'));

    await record.begin(
      ctx,
      [
        'input',
      ],
      NO_FLOW,
      {
        removed: [
          'gone',
        ],
      },
    );

    expect((await record.steers()).map((steer) => steer.id)).toEqual([
      'stays',
    ]);
    expect((await record.turn())?.messageIds).toEqual([
      'input',
    ]);
  });

  it('drops nothing when another harness took the turn at a higher term', async () => {
    const storage = createInMemoryStorage();
    const newer = makeRecord(storage);
    await newer.keepSteer(message('gone', 'between-rounds'));
    newer.hold(fenceAt(2));
    await newer.begin(ctx, [], NO_FLOW);

    const stale = makeRecord(storage);
    stale.hold(fenceAt(1));
    const error = await stale
      .begin(ctx, [], NO_FLOW, {
        removed: [
          'gone',
        ],
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NoeticErrorImpl);
    assert(error instanceof NoeticErrorImpl);
    expect(error.noeticError.kind).toBe('lease_lost');
    expect((await stale.steers()).map((steer) => steer.id)).toEqual([
      'gone',
    ]);
  });
});
