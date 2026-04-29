import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ExitCallbacks, ExitState } from '../src/tui/input/exit-dispatch.js';
import { applyExitDecision, isExitArmedExpired } from '../src/tui/input/exit-dispatch.js';

const NOW = 1_000_000;

function callbacks(): ExitCallbacks {
  return {
    onAbortTurn: mock(() => {}),
    onShowHint: mock(() => {}),
    onExitGracefully: mock(() => {}),
  };
}

describe('applyExitDecision', () => {
  let cb: ExitCallbacks;

  beforeEach(() => {
    cb = callbacks();
  });

  test('abort-turn calls onAbortTurn and clears any armed hint', () => {
    const next = applyExitDecision({
      decision: {
        kind: 'abort-turn',
      },
      state: {
        pendingExitArmedAt: NOW - 100,
      },
      now: NOW,
      callbacks: cb,
    });
    expect(cb.onAbortTurn).toHaveBeenCalledTimes(1);
    expect(cb.onShowHint).not.toHaveBeenCalled();
    expect(cb.onExitGracefully).not.toHaveBeenCalled();
    expect(next).toEqual({
      pendingExitArmedAt: null,
    });
  });

  test('show-exit-hint calls onShowHint and arms timer at now', () => {
    const next = applyExitDecision({
      decision: {
        kind: 'show-exit-hint',
      },
      state: {
        pendingExitArmedAt: null,
      },
      now: NOW,
      callbacks: cb,
    });
    expect(cb.onShowHint).toHaveBeenCalledTimes(1);
    expect(cb.onAbortTurn).not.toHaveBeenCalled();
    expect(cb.onExitGracefully).not.toHaveBeenCalled();
    expect(next).toEqual({
      pendingExitArmedAt: NOW,
    });
  });

  test('exit-now calls onExitGracefully and clears armed timer', () => {
    const next = applyExitDecision({
      decision: {
        kind: 'exit-now',
      },
      state: {
        pendingExitArmedAt: NOW - 200,
      },
      now: NOW,
      callbacks: cb,
    });
    expect(cb.onExitGracefully).toHaveBeenCalledTimes(1);
    expect(cb.onAbortTurn).not.toHaveBeenCalled();
    expect(cb.onShowHint).not.toHaveBeenCalled();
    expect(next).toEqual({
      pendingExitArmedAt: null,
    });
  });

  test('noop fires no callbacks and preserves state', () => {
    const state: ExitState = {
      pendingExitArmedAt: NOW - 50,
    };
    const next = applyExitDecision({
      decision: {
        kind: 'noop',
      },
      state,
      now: NOW,
      callbacks: cb,
    });
    expect(cb.onAbortTurn).not.toHaveBeenCalled();
    expect(cb.onShowHint).not.toHaveBeenCalled();
    expect(cb.onExitGracefully).not.toHaveBeenCalled();
    expect(next).toEqual(state);
    expect(next).not.toBe(state);
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
