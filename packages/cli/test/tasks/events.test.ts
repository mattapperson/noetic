import { afterEach, describe, expect, it } from 'bun:test';

import {
  emitTaskEvent,
  offTaskEvent,
  onTaskEvent,
  taskEvents,
} from '../../src/commands/builtins/tasks/events.js';
import type { Event } from '../../src/commands/builtins/tasks/schemas.js';
import { EventKind } from '../../src/commands/builtins/tasks/schemas.js';

//#region Helpers

const NOW = '2026-04-30T00:00:00.000Z';

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 1,
    taskId: 'T-abcdefghij',
    kind: EventKind.TaskCreated,
    payload: {
      title: 'hello',
    },
    ts: NOW,
    ...overrides,
  };
}

afterEach(() => {
  // Belt-and-braces: ensure no listeners leak between tests.
  taskEvents.removeAllListeners();
});

//#endregion

//#region Subscribe / emit / unsubscribe

describe('taskEvents in-process bus', () => {
  it('delivers events to a subscribed listener with the full payload shape', () => {
    const received: Event[] = [];
    const listener = (event: Event): void => {
      received.push(event);
    };
    onTaskEvent(EventKind.TaskCreated, listener);

    const event = makeEvent();
    emitTaskEvent(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
    expect(received[0]?.id).toBe(1);
    expect(received[0]?.taskId).toBe('T-abcdefghij');
    expect(received[0]?.payload).toEqual({
      title: 'hello',
    });
    expect(received[0]?.kind).toBe(EventKind.TaskCreated);
    expect(received[0]?.ts).toBe(NOW);
  });

  it('only fires listeners whose kind matches the emitted event', () => {
    const created: Event[] = [];
    const archived: Event[] = [];
    onTaskEvent(EventKind.TaskCreated, (e) => created.push(e));
    onTaskEvent(EventKind.TaskArchived, (e) => archived.push(e));

    emitTaskEvent(
      makeEvent({
        kind: EventKind.TaskCreated,
      }),
    );

    expect(created).toHaveLength(1);
    expect(archived).toHaveLength(0);
  });

  it('fans out to multiple listeners on the same kind in subscription order', () => {
    const order: string[] = [];
    onTaskEvent(EventKind.TaskUpdated, () => order.push('a'));
    onTaskEvent(EventKind.TaskUpdated, () => order.push('b'));
    onTaskEvent(EventKind.TaskUpdated, () => order.push('c'));

    emitTaskEvent(
      makeEvent({
        kind: EventKind.TaskUpdated,
      }),
    );

    expect(order).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('offTaskEvent removes the supplied listener and leaves others intact', () => {
    const a: Event[] = [];
    const b: Event[] = [];
    const listenerA = (e: Event): void => {
      a.push(e);
    };
    const listenerB = (e: Event): void => {
      b.push(e);
    };
    onTaskEvent(EventKind.TaskMoved, listenerA);
    onTaskEvent(EventKind.TaskMoved, listenerB);

    offTaskEvent(EventKind.TaskMoved, listenerA);

    emitTaskEvent(
      makeEvent({
        kind: EventKind.TaskMoved,
      }),
    );

    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  it('emitting with no subscribers is a no-op', () => {
    expect(() =>
      emitTaskEvent(
        makeEvent({
          kind: EventKind.LogAppended,
        }),
      ),
    ).not.toThrow();
  });

  it('offTaskEvent on an unknown listener is a no-op', () => {
    const orphan = (_e: Event): void => {
      /* never called */
    };
    expect(() => offTaskEvent(EventKind.TaskCreated, orphan)).not.toThrow();
  });

  it('preserves nullable taskId on hierarchy-scope events', () => {
    const seen: Event[] = [];
    onTaskEvent(EventKind.HierarchyStatusChanged, (e) => seen.push(e));

    emitTaskEvent(
      makeEvent({
        kind: EventKind.HierarchyStatusChanged,
        taskId: null,
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.taskId).toBeNull();
  });
});

//#endregion
