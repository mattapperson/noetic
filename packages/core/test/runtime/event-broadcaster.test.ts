import { describe, expect, it } from 'bun:test';
import { EventBroadcaster } from '../../src/runtime/event-broadcaster';
import type { StreamEvent } from '../../src/types/harness-result';

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
});
