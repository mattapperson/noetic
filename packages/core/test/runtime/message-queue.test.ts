import { describe, expect, test } from 'bun:test';
import type { QueuedMessage } from '../../src/runtime/message-queue';
import { MessageQueue } from '../../src/runtime/message-queue';

//#region Helpers

function makeMessage(id: string): QueuedMessage {
  return {
    id,
    input: id,
    deliveryMode: 'next-turn',
    options: {},
    enqueuedAt: 0,
  };
}

//#endregion

describe('MessageQueue', () => {
  test('enqueue preserves FIFO order on drainAll', () => {
    const q = new MessageQueue();
    q.enqueue(makeMessage('a'));
    q.enqueue(makeMessage('b'));
    q.enqueue(makeMessage('c'));
    const drained = q.drainAll();
    expect(drained.map((m) => m.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(q.size).toBe(0);
  });

  test('prepend puts message at the head', () => {
    const q = new MessageQueue();
    q.enqueue(makeMessage('a'));
    q.enqueue(makeMessage('b'));
    q.prepend(makeMessage('head'));
    const drained = q.drainAll();
    expect(drained.map((m) => m.id)).toEqual([
      'head',
      'a',
      'b',
    ]);
  });

  test('peekAll exposes current items without draining', () => {
    const q = new MessageQueue();
    q.enqueue(makeMessage('a'));
    q.enqueue(makeMessage('b'));
    const peeked = q.peekAll();
    expect(peeked.map((m) => m.id)).toEqual([
      'a',
      'b',
    ]);
    expect(q.size).toBe(2);
  });

  test('drainAll on empty returns empty without firing listener', () => {
    const q = new MessageQueue();
    const sizes: number[] = [];
    q.subscribe((s) => sizes.push(s));
    const drained = q.drainAll();
    expect(drained).toEqual([]);
    expect(sizes).toEqual([]);
  });

  test('subscribe fires on enqueue, prepend, and drain with current size', () => {
    const q = new MessageQueue();
    const sizes: number[] = [];
    q.subscribe((s) => sizes.push(s));

    q.enqueue(makeMessage('a'));
    q.enqueue(makeMessage('b'));
    q.prepend(makeMessage('head'));
    q.drainAll();

    expect(sizes).toEqual([
      1,
      2,
      3,
      0,
    ]);
  });

  test('unsubscribe stops notifications', () => {
    const q = new MessageQueue();
    const sizes: number[] = [];
    const unsub = q.subscribe((s) => sizes.push(s));
    q.enqueue(makeMessage('a'));
    unsub();
    q.enqueue(makeMessage('b'));
    expect(sizes).toEqual([
      1,
    ]);
  });

  test('size reflects post-mutation count', () => {
    const q = new MessageQueue();
    expect(q.size).toBe(0);
    q.enqueue(makeMessage('a'));
    expect(q.size).toBe(1);
    q.drainAll();
    expect(q.size).toBe(0);
  });
});
