import { afterEach, describe, expect, test } from 'bun:test';
import {
  iterMouseEventsWithReplacement,
  subscribeMouseEvents,
} from '../src/tui/components/mouse-stdin-filter.js';

const ESC = String.fromCharCode(0x1b);

describe('iterMouseEventsWithReplacement', () => {
  test('extracts a single mouse event and returns an empty cleaned chunk', () => {
    const { events, cleaned } = iterMouseEventsWithReplacement(`${ESC}[<64;10;5M`);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('wheel-up');
    expect(cleaned).toBe('');
  });

  test('extracts back-to-back events (the case that actually broke the prompt)', () => {
    const chunk = `${ESC}[<64;1;1M${ESC}[<64;1;1M${ESC}[<65;2;2M`;
    const { events, cleaned } = iterMouseEventsWithReplacement(chunk);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.kind)).toEqual([
      'wheel-up',
      'wheel-up',
      'wheel-down',
    ]);
    expect(cleaned).toBe('');
  });

  test('preserves interleaved keystroke bytes', () => {
    // A `q` keystroke between two scroll events must reach ink intact.
    const chunk = `${ESC}[<64;1;1Mq${ESC}[<65;2;2M`;
    const { events, cleaned } = iterMouseEventsWithReplacement(chunk);
    expect(events).toHaveLength(2);
    expect(cleaned).toBe('q');
  });

  test('passes a pure-keystroke chunk through untouched', () => {
    const chunk = 'hello world';
    const { events, cleaned } = iterMouseEventsWithReplacement(chunk);
    expect(events).toEqual([]);
    expect(cleaned).toBe('hello world');
  });

  test('preserves a non-mouse CSI escape (e.g. PgUp = ESC [ 5 ~)', () => {
    const chunk = `${ESC}[5~`;
    const { events, cleaned } = iterMouseEventsWithReplacement(chunk);
    expect(events).toEqual([]);
    expect(cleaned).toBe(chunk);
  });

  test('preserves an isolated ESC byte', () => {
    const { events, cleaned } = iterMouseEventsWithReplacement(ESC);
    expect(events).toEqual([]);
    expect(cleaned).toBe(ESC);
  });

  test('returns an empty result for an empty chunk', () => {
    const { events, cleaned } = iterMouseEventsWithReplacement('');
    expect(events).toEqual([]);
    expect(cleaned).toBe('');
  });
});

// The refcounted runtime patch is verified through the public
// `subscribeMouseEvents` contract: install on first subscribe, uninstall
// on last unsubscribe, dispatch parsed mouse events to every active
// listener, and strip the mouse bytes from what other `'data'` consumers
// see. We exercise it by emitting on `process.stdin` directly while
// capturing what downstream listeners receive — the install path
// monkey-patches `emit`, so an `emit` call models a real stdin chunk.

describe('subscribeMouseEvents — runtime stdin patch', () => {
  const unsubscribes: Array<() => void> = [];

  afterEach(() => {
    while (unsubscribes.length > 0) {
      const fn = unsubscribes.pop();
      if (fn) {
        fn();
      }
    }
  });

  test('first subscribe installs a stdin patch that strips mouse bytes for downstream listeners', () => {
    const seen: Buffer[] = [];
    const dataListener = (chunk: unknown): void => {
      if (typeof chunk === 'string') {
        seen.push(Buffer.from(chunk));
      } else if (Buffer.isBuffer(chunk)) {
        seen.push(chunk);
      }
    };
    process.stdin.on('data', dataListener);

    const events: string[] = [];
    unsubscribes.push(
      subscribeMouseEvents((ev) => {
        events.push(ev.kind);
      }),
    );

    // Pure mouse chunk: downstream listener must see nothing; subscriber gets the parsed event.
    process.stdin.emit('data', `${ESC}[<64;1;1M`);
    // Mixed chunk: subscriber gets the event; downstream listener sees only the keystroke.
    process.stdin.emit('data', `${ESC}[<65;1;1Mq`);
    // Pure keystroke (fast path): downstream listener sees it unchanged; subscriber gets nothing.
    process.stdin.emit('data', 'hello');

    process.stdin.off('data', dataListener);

    expect(events).toEqual([
      'wheel-up',
      'wheel-down',
    ]);
    const seenStr = seen.map((b) => b.toString('utf8'));
    expect(seenStr).toEqual([
      'q',
      'hello',
    ]);
  });

  test('multiple subscribers all receive each event (broadcast, not pop)', () => {
    const a: string[] = [];
    const b: string[] = [];
    unsubscribes.push(
      subscribeMouseEvents((ev) => {
        a.push(ev.kind);
      }),
    );
    unsubscribes.push(
      subscribeMouseEvents((ev) => {
        b.push(ev.kind);
      }),
    );

    process.stdin.emit('data', `${ESC}[<64;1;1M`);

    expect(a).toEqual([
      'wheel-up',
    ]);
    expect(b).toEqual([
      'wheel-up',
    ]);
  });

  test('unsubscribing removes only that listener — other subscribers still receive events', () => {
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = subscribeMouseEvents((ev) => {
      a.push(ev.kind);
    });
    unsubscribes.push(
      subscribeMouseEvents((ev) => {
        b.push(ev.kind);
      }),
    );

    unsubA();

    process.stdin.emit('data', `${ESC}[<64;1;1M`);

    expect(a).toEqual([]);
    expect(b).toEqual([
      'wheel-up',
    ]);
  });

  test('last unsubscribe restores stdin.emit so downstream consumers see raw mouse bytes again', () => {
    // We can't reliably compare function identity (the patch saves a
    // bound version of `emit`, and successive install/restore cycles
    // accumulate bind layers), so probe behaviour instead: after the
    // last unsubscribe, a downstream `'data'` listener must receive the
    // mouse bytes UNCHANGED — confirming the wrapper is gone.
    const seen: string[] = [];
    const dataListener = (chunk: unknown): void => {
      if (typeof chunk === 'string') {
        seen.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        seen.push(chunk.toString('utf8'));
      }
    };

    const unsub = subscribeMouseEvents(() => {
      // Subscriber receives parsed events while installed — irrelevant here.
    });
    unsub();

    process.stdin.on('data', dataListener);
    const mouseChunk = `${ESC}[<64;1;1M`;
    process.stdin.emit('data', mouseChunk);
    process.stdin.off('data', dataListener);

    expect(seen).toEqual([
      mouseChunk,
    ]);
  });

  test('a misbehaving listener does not break dispatch for other subscribers', () => {
    const survivor: string[] = [];
    unsubscribes.push(
      subscribeMouseEvents(() => {
        throw new Error('boom');
      }),
    );
    unsubscribes.push(
      subscribeMouseEvents((ev) => {
        survivor.push(ev.kind);
      }),
    );

    expect(() => process.stdin.emit('data', `${ESC}[<64;1;1M`)).not.toThrow();
    expect(survivor).toEqual([
      'wheel-up',
    ]);
  });
});
