import { describe, expect, test } from 'bun:test';
import { iterMouseEvents, parseMouseEvent } from '../src/tui/components/parse-mouse-event.js';

const ESC = String.fromCharCode(0x1b);

describe('parseMouseEvent', () => {
  test('parses a wheel-up event', () => {
    const parsed = parseMouseEvent(`${ESC}[<64;10;5M`);
    expect(parsed?.event.kind).toBe('wheel-up');
    expect(parsed?.event.x).toBe(10);
    expect(parsed?.event.y).toBe(5);
    expect(parsed?.consumed).toBe(`${ESC}[<64;10;5M`.length);
  });

  test('parses a wheel-down event', () => {
    const parsed = parseMouseEvent(`${ESC}[<65;1;1M`);
    expect(parsed?.event.kind).toBe('wheel-down');
  });

  test('extracts modifiers from the button bitfield', () => {
    // 64 (wheel up) + 4 (shift) + 16 (ctrl) = 84.
    const parsed = parseMouseEvent(`${ESC}[<84;1;1M`);
    expect(parsed?.event.kind).toBe('wheel-up');
    expect(parsed?.event.shift).toBe(true);
    expect(parsed?.event.ctrl).toBe(true);
    expect(parsed?.event.meta).toBe(false);
  });

  test('distinguishes press vs release by final byte', () => {
    expect(parseMouseEvent(`${ESC}[<0;1;1M`)?.event.kind).toBe('press');
    expect(parseMouseEvent(`${ESC}[<0;1;1m`)?.event.kind).toBe('release');
  });

  test('horizontal wheel maps to `other`, not wheel-up/down', () => {
    expect(parseMouseEvent(`${ESC}[<66;1;1M`)?.event.kind).toBe('other');
    expect(parseMouseEvent(`${ESC}[<67;1;1M`)?.event.kind).toBe('other');
  });

  test('returns null on a non-mouse sequence (keystroke escape)', () => {
    // PgUp arrives as ESC[5~ — same prefix, different shape.
    expect(parseMouseEvent(`${ESC}[5~`)).toBeNull();
  });

  test('returns null on a plain character', () => {
    expect(parseMouseEvent('a')).toBeNull();
  });
});

describe('iterMouseEvents', () => {
  test('yields each mouse event in a back-to-back chunk', () => {
    const chunk = `${ESC}[<64;1;1M${ESC}[<65;2;2M`;
    const events = Array.from(iterMouseEvents(chunk));
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('wheel-up');
    expect(events[1]?.kind).toBe('wheel-down');
  });

  test('walks past intervening non-mouse bytes', () => {
    // A keystroke escape between two mouse events should be skipped without
    // swallowing either.
    const chunk = `${ESC}[<64;1;1M${ESC}[5~${ESC}[<65;2;2M`;
    const events = Array.from(iterMouseEvents(chunk));
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('wheel-up');
    expect(events[1]?.kind).toBe('wheel-down');
  });

  test('yields nothing when the chunk is empty', () => {
    expect(Array.from(iterMouseEvents(''))).toEqual([]);
  });
});
