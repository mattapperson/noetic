import { describe, expect, test } from 'bun:test';
import type { ExitState } from '../src/tui/input/exit-dispatch.js';
import { applyExitDecision, isExitArmedExpired } from '../src/tui/input/exit-dispatch.js';

const NOW = 1_000_000;

describe('applyExitDecision', () => {
  test('abort-turn → fire: abort-turn, clears armed hint', () => {
    const result = applyExitDecision({
      decision: {
        kind: 'abort-turn',
      },
      state: {
        pendingExitArmedAt: NOW - 100,
      },
      now: NOW,
    });
    expect(result.fire).toBe('abort-turn');
    expect(result.nextState).toEqual({
      pendingExitArmedAt: null,
    });
  });

  test('show-exit-hint → fire: show-exit-hint, arms timer at now', () => {
    const result = applyExitDecision({
      decision: {
        kind: 'show-exit-hint',
      },
      state: {
        pendingExitArmedAt: null,
      },
      now: NOW,
    });
    expect(result.fire).toBe('show-exit-hint');
    expect(result.nextState).toEqual({
      pendingExitArmedAt: NOW,
    });
  });

  test('exit-now → fire: exit-now, clears armed timer', () => {
    const result = applyExitDecision({
      decision: {
        kind: 'exit-now',
      },
      state: {
        pendingExitArmedAt: NOW - 200,
      },
      now: NOW,
    });
    expect(result.fire).toBe('exit-now');
    expect(result.nextState).toEqual({
      pendingExitArmedAt: null,
    });
  });

  test('noop → fire: noop, preserves state', () => {
    const state: ExitState = {
      pendingExitArmedAt: NOW - 50,
    };
    const result = applyExitDecision({
      decision: {
        kind: 'noop',
      },
      state,
      now: NOW,
    });
    expect(result.fire).toBe('noop');
    expect(result.nextState).toEqual(state);
    expect(result.nextState).not.toBe(state);
  });
});

describe('isExitArmedExpired', () => {
  const windowMs = 800;

  test('not armed → false', () => {
    expect(
      isExitArmedExpired(
        {
          pendingExitArmedAt: null,
        },
        NOW,
        windowMs,
      ),
    ).toBe(false);
  });

  test('armed inside window → false', () => {
    expect(
      isExitArmedExpired(
        {
          pendingExitArmedAt: NOW - 200,
        },
        NOW,
        windowMs,
      ),
    ).toBe(false);
  });

  test('armed exactly at window boundary → false (still armed)', () => {
    expect(
      isExitArmedExpired(
        {
          pendingExitArmedAt: NOW - windowMs,
        },
        NOW,
        windowMs,
      ),
    ).toBe(false);
  });

  test('armed one ms past window → true', () => {
    expect(
      isExitArmedExpired(
        {
          pendingExitArmedAt: NOW - windowMs - 1,
        },
        NOW,
        windowMs,
      ),
    ).toBe(true);
  });

  test('armed far in the past → true', () => {
    expect(
      isExitArmedExpired(
        {
          pendingExitArmedAt: NOW - 10_000,
        },
        NOW,
        windowMs,
      ),
    ).toBe(true);
  });
});
