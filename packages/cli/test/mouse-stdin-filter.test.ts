import { describe, expect, test } from 'bun:test';
import { iterMouseEventsWithReplacement } from '../src/tui/components/mouse-stdin-filter.js';

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
