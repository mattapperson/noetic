import { describe, expect, it } from 'bun:test';
import type { StreamEvent } from '@noetic-tools/types';
import { EventBroadcaster } from '../../src/runtime/event-broadcaster';

function textDelta(text: string): StreamEvent {
  return {
    source: 'sdk',
    type: 'response.output_text.delta',
    data: {
      delta: text,
    },
    outputIndex: 0,
  };
}

function frameworkEvent(type: `${string}:${string}`, data: Record<string, unknown>): StreamEvent {
  return {
    source: 'framework',
    type,
    data,
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iter) {
    items.push(item);
  }
  return items;
}

describe('EventBroadcaster', () => {
  it('emits events to a single consumer', async () => {
    const bc = new EventBroadcaster();
    const promise = collect(bc);

    bc.emit(textDelta('hello'));
    bc.emit(textDelta(' world'));
    bc.complete();

    const events = await promise;
    expect(events).toHaveLength(2);
    expect(events[0].data.delta).toBe('hello');
    expect(events[1].data.delta).toBe(' world');
  });

  it('supports multiple concurrent consumers', async () => {
    const bc = new EventBroadcaster();
    const p1 = collect(bc);
    const p2 = collect(bc);

    bc.emit(textDelta('a'));
    bc.emit(textDelta('b'));
    bc.complete();

    const [r1, r2] = await Promise.all([
      p1,
      p2,
    ]);
    expect(r1).toHaveLength(2);
    expect(r2).toHaveLength(2);
    expect(r1[0].data.delta).toBe('a');
    expect(r2[0].data.delta).toBe('a');
  });

  it('replays buffered events for late subscribers', async () => {
    const bc = new EventBroadcaster();

    bc.emit(textDelta('early'));
    bc.emit(textDelta('also early'));

    // Subscribe after events were emitted
    const promise = collect(bc);

    bc.emit(textDelta('late'));
    bc.complete();

    const events = await promise;
    expect(events).toHaveLength(3);
    expect(events[0].data.delta).toBe('early');
    expect(events[1].data.delta).toBe('also early');
    expect(events[2].data.delta).toBe('late');
  });

  it('complete() ends all iterators', async () => {
    const bc = new EventBroadcaster();
    bc.complete();

    const events = await collect(bc);
    expect(events).toHaveLength(0);
  });

  it('error() propagates to all iterators', async () => {
    const bc = new EventBroadcaster();
    const promise = collect(bc);

    bc.emit(textDelta('before error'));
    bc.error(new Error('test error'));

    try {
      await promise;
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      if (e instanceof Error) {
        expect(e.message).toBe('test error');
      }
    }
  });

  it('ignores emit after complete', async () => {
    const bc = new EventBroadcaster();
    const promise = collect(bc);

    bc.emit(textDelta('before'));
    bc.complete();
    bc.emit(textDelta('after'));

    const events = await promise;
    expect(events).toHaveLength(1);
  });

  it('handles mixed sdk and framework events', async () => {
    const bc = new EventBroadcaster();
    const promise = collect(bc);

    bc.emit(textDelta('text'));
    bc.emit(
      frameworkEvent('test:step_started', {
        stepId: 's1',
      }),
    );
    bc.complete();

    const events = await promise;
    expect(events).toHaveLength(2);
    expect(events[0].source).toBe('sdk');
    expect(events[1].source).toBe('framework');
  });

  it('iterator return() removes the consumer', async () => {
    const bc = new EventBroadcaster();
    const iter = bc[Symbol.asyncIterator]();

    bc.emit(textDelta('a'));
    const first = await iter.next();
    expect(first.done).toBe(false);

    await iter.return?.();
    bc.emit(textDelta('b'));
    bc.complete();

    const after = await iter.next();
    expect(after.done).toBe(true);
  });

  it('trims buffer when exceeding maxBufferSize', async () => {
    const bc = new EventBroadcaster({
      maxBufferSize: 5,
    });

    // Emit 8 events — only last 5 should remain
    for (let i = 0; i < 8; i++) {
      bc.emit(textDelta(`event-${i}`));
    }
    expect(bc.bufferSize).toBe(5);

    // Late subscriber should only see the retained window
    const promise = collect(bc);
    bc.complete();

    const events = await promise;
    expect(events).toHaveLength(5);
    expect(events[0].data.delta).toBe('event-3');
    expect(events[4].data.delta).toBe('event-7');
  });

  it('adjusts active iterator cursors on buffer trim', async () => {
    const bc = new EventBroadcaster({
      maxBufferSize: 3,
    });
    const iter = bc[Symbol.asyncIterator]();

    // Read first event
    bc.emit(textDelta('a'));
    const first = await iter.next();
    expect(first.done).toBe(false);

    // Emit enough to trigger trim — cursor should adjust
    bc.emit(textDelta('b'));
    bc.emit(textDelta('c'));
    bc.emit(textDelta('d'));
    bc.emit(textDelta('e'));

    bc.complete();

    // Collect remaining from iterator
    const remaining: StreamEvent[] = [];
    let next = await iter.next();
    while (!next.done) {
      remaining.push(next.value);
      next = await iter.next();
    }

    // After reading 'a', consumed-watermark trim already dropped it. The
    // maxBufferSize=3 backstop then keeps [c,d,e] of the unread suffix.
    expect(remaining).toHaveLength(3);
    expect(remaining[0].data.delta).toBe('c');
    expect(remaining[1].data.delta).toBe('d');
    expect(remaining[2].data.delta).toBe('e');
  });

  it('trims behind the slowest live consumer', async () => {
    const bc = new EventBroadcaster();
    const iter = bc[Symbol.asyncIterator]();

    bc.emit(textDelta('a'));
    bc.emit(textDelta('b'));
    expect(bc.bufferSize).toBe(2);

    expect((await iter.next()).done).toBe(false);
    expect(bc.bufferSize).toBe(1);
    expect((await iter.next()).done).toBe(false);
    expect(bc.bufferSize).toBe(0);

    bc.emit(textDelta('c'));
    bc.complete();
    expect((await iter.next()).value?.data.delta).toBe('c');
  });

  it('starts late joiners at the consumed watermark after a first consumer exists', async () => {
    const bc = new EventBroadcaster();
    const first = bc[Symbol.asyncIterator]();

    bc.emit(textDelta('early'));
    expect((await first.next()).value?.data.delta).toBe('early');

    const late = collect(bc);
    bc.emit(textDelta('after'));
    bc.complete();

    const events = await late;
    expect(events).toHaveLength(1);
    expect(events[0].data.delta).toBe('after');
  });

  it('stops buffering when all consumers have departed', async () => {
    const bc = new EventBroadcaster();

    // Subscribe and immediately break
    const iter = bc[Symbol.asyncIterator]();
    bc.emit(textDelta('before'));
    await iter.next();
    await iter.return?.();

    // Now emit more — buffer should NOT grow since all consumers left
    const sizeBefore = bc.bufferSize;
    bc.emit(textDelta('after-1'));
    bc.emit(textDelta('after-2'));
    expect(bc.bufferSize).toBe(sizeBefore);
  });

  it('still buffers when no consumers have subscribed yet (for replay)', () => {
    const bc = new EventBroadcaster();

    bc.emit(textDelta('early-1'));
    bc.emit(textDelta('early-2'));
    expect(bc.bufferSize).toBe(2);
  });
});

describe('EventBroadcaster bounded-memory regression (DEV-819)', () => {
  it('buffer never exceeds maxBufferSize under large publish volume with no consumer', () => {
    const bc = new EventBroadcaster({
      maxBufferSize: 100,
    });

    // Publish 50x the cap. The pre-fix (unbounded) implementation retained
    // every event; the bounded one must hold exactly at the cap.
    for (let i = 0; i < 5_000; i++) {
      bc.emit(textDelta(`e-${i}`));
      // Structural invariant on every emit, not just at the end.
      expect(bc.bufferSize).toBeLessThanOrEqual(100);
    }
    expect(bc.bufferSize).toBe(100);

    // Drop-oldest: only the newest window survives.
    const buffer = bc.getBuffer();
    expect(buffer[0]?.data.delta).toBe('e-4900');
    expect(buffer[buffer.length - 1]?.data.delta).toBe('e-4999');
  });

  it('buffer stays bounded with a live slow consumer and default cap', () => {
    // Default cap is 10k. Publish 30k events with a subscriber that never
    // reads — the cap backstop must hold regardless of the watermark trim.
    const bc = new EventBroadcaster();
    bc[Symbol.asyncIterator](); // subscribe but never read

    for (let i = 0; i < 30_000; i++) {
      bc.emit(textDelta(`e-${i}`));
    }
    expect(bc.bufferSize).toBeLessThanOrEqual(10_000);
  });

  it('buffer stays near zero with an active consumer keeping up', async () => {
    const bc = new EventBroadcaster();
    const iter = bc[Symbol.asyncIterator]();

    for (let i = 0; i < 1_000; i++) {
      bc.emit(textDelta(`e-${i}`));
      const next = await iter.next();
      expect(next.done).toBe(false);
      // Consumed-watermark trim keeps the buffer at 0 behind a caught-up
      // reader — the unbounded pre-fix code grew this to i+1.
      expect(bc.bufferSize).toBe(0);
    }
    bc.complete();
  });

  it('unsubscribe frees per-subscriber state: after the last consumer departs, emits are discarded', async () => {
    const bc = new EventBroadcaster({
      maxBufferSize: 10,
    });
    const iter1 = bc[Symbol.asyncIterator]();
    const iter2 = bc[Symbol.asyncIterator]();

    bc.emit(textDelta('a'));
    await iter1.next();
    await iter2.next();
    await iter1.return?.();
    await iter2.return?.();

    // Both consumers gone: new emits must not accumulate (post-fix discard
    // path), so the buffer cannot grow past zero even under volume.
    for (let i = 0; i < 1_000; i++) {
      bc.emit(textDelta(`post-${i}`));
    }
    expect(bc.bufferSize).toBe(0);

    // A new subscriber after the gap starts fresh — no stale replay.
    const lateEvents = collect(bc);
    bc.complete();
    // Started before complete, so it sees only post-subscribe events — and
    // there are none, since everything emitted during the gap was discarded.
    expect(await lateEvents).toHaveLength(0);
  });

  it('eviction notifies live iterators so a lagging consumer is not stranded', async () => {
    // A consumer that falls behind past the cap has its cursor clamped; it
    // must still terminate cleanly with the retained window rather than hang.
    const bc = new EventBroadcaster({
      maxBufferSize: 5,
    });
    const iter = bc[Symbol.asyncIterator]();

    for (let i = 0; i < 20; i++) {
      bc.emit(textDelta(`e-${i}`));
    }
    bc.complete();

    const remaining: StreamEvent[] = [];
    let next = await iter.next();
    while (!next.done) {
      remaining.push(next.value);
      next = await iter.next();
    }
    // Only the newest 5 survive; oldest were evicted per drop-oldest policy.
    expect(remaining.map((e) => e.data.delta)).toEqual([
      'e-15',
      'e-16',
      'e-17',
      'e-18',
      'e-19',
    ]);
  });
});

describe('BroadcastIterator pipelined next() (C9)', () => {
  function getText(result: IteratorResult<StreamEvent>): string {
    if (result.done) {
      throw new Error('expected a value result');
    }
    const data = result.value.data;
    if (typeof data !== 'object' || data === null || !('delta' in data)) {
      throw new Error('expected a text delta event');
    }
    return String(data.delta);
  }

  it('two pipelined next() calls receive emitted events in FIFO order', async () => {
    const bc = new EventBroadcaster();
    const iter = bc[Symbol.asyncIterator]();

    const first = iter.next();
    const second = iter.next();
    bc.emit(textDelta('a'));
    bc.emit(textDelta('b'));

    expect(getText(await first)).toBe('a');
    expect(getText(await second)).toBe('b');
  });

  it('complete() settles all pipelined waiters with done', async () => {
    const bc = new EventBroadcaster();
    const iter = bc[Symbol.asyncIterator]();

    const first = iter.next();
    const second = iter.next();
    bc.complete();

    expect((await first).done).toBe(true);
    expect((await second).done).toBe(true);
  });

  it('error() rejects all pipelined waiters', async () => {
    const bc = new EventBroadcaster();
    const iter = bc[Symbol.asyncIterator]();

    const first = iter.next();
    const second = iter.next();
    // Attach handlers before triggering so neither rejection is ever
    // observed as unhandled.
    const settled = Promise.allSettled([
      first,
      second,
    ]);
    bc.error(new Error('stream broke'));

    const [r1, r2] = await settled;
    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');
    if (r1.status === 'rejected') {
      expect(String(r1.reason)).toContain('stream broke');
    }
    if (r2.status === 'rejected') {
      expect(String(r2.reason)).toContain('stream broke');
    }
  });

  it('return() settles parked waiters with done', async () => {
    const bc = new EventBroadcaster();
    const iter = bc[Symbol.asyncIterator]();

    const first = iter.next();
    const second = iter.next();
    const ret = await iter.return!();

    expect(ret.done).toBe(true);
    expect((await first).done).toBe(true);
    expect((await second).done).toBe(true);
  });

  it('for-await consumption is unaffected (regression)', async () => {
    const bc = new EventBroadcaster();
    bc.emit(textDelta('x'));
    bc.emit(textDelta('y'));
    queueMicrotask(() => {
      bc.complete();
    });
    const events = await collect(bc);
    expect(events).toHaveLength(2);
  });
});
