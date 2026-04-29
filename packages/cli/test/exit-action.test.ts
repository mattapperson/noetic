import { describe, expect, test } from 'bun:test';
import type { ExitActionInput } from '../src/tui/input/exit-action.js';
import { DOUBLE_PRESS_WINDOW_MS, decideExitAction } from '../src/tui/input/exit-action.js';

const NOW = 1_000_000;

function input(overrides: Partial<ExitActionInput> = {}): ExitActionInput {
  return {
    key: 'ctrl-c',
    status: 'idle',
    inputBufferEmpty: true,
    pendingExitArmedAt: null,
    now: NOW,
    doublePressWindowMs: DOUBLE_PRESS_WINDOW_MS,
    ...overrides,
  };
}

describe('decideExitAction', () => {
  describe('Ctrl+C', () => {
    test('streaming turn → abort-turn', () => {
      expect(
        decideExitAction(
          input({
            key: 'ctrl-c',
            status: 'streaming',
          }),
        ),
      ).toEqual({
        kind: 'abort-turn',
      });
    });

    test('submitted (queued) turn treated as streaming → abort-turn', () => {
      expect(
        decideExitAction(
          input({
            key: 'ctrl-c',
            status: 'submitted',
          }),
        ),
      ).toEqual({
        kind: 'abort-turn',
      });
    });

    test('idle, hint not armed → show-exit-hint', () => {
      expect(
        decideExitAction(
          input({
            key: 'ctrl-c',
            status: 'idle',
            pendingExitArmedAt: null,
          }),
        ),
      ).toEqual({
        kind: 'show-exit-hint',
      });
    });

    test('idle, armed 200 ms ago → exit-now', () => {
      expect(
        decideExitAction(
          input({
            key: 'ctrl-c',
            status: 'idle',
            pendingExitArmedAt: NOW - 200,
          }),
        ),
      ).toEqual({
        kind: 'exit-now',
      });
    });

    test('idle, window expired (1200 ms ago) → show-exit-hint (re-arm)', () => {
      expect(
        decideExitAction(
          input({
            key: 'ctrl-c',
            status: 'idle',
            pendingExitArmedAt: NOW - 1200,
          }),
        ),
      ).toEqual({
        kind: 'show-exit-hint',
      });
    });

    test('boundary inclusive: armed exactly window-ago → exit-now', () => {
      expect(
        decideExitAction(
          input({
            key: 'ctrl-c',
            status: 'idle',
            pendingExitArmedAt: NOW - DOUBLE_PRESS_WINDOW_MS,
          }),
        ),
      ).toEqual({
        kind: 'exit-now',
      });
    });

    test('boundary exclusive: armed window+1 ms ago → show-exit-hint', () => {
      expect(
        decideExitAction(
          input({
            key: 'ctrl-c',
            status: 'idle',
            pendingExitArmedAt: NOW - DOUBLE_PRESS_WINDOW_MS - 1,
          }),
        ),
      ).toEqual({
        kind: 'show-exit-hint',
      });
    });

    test('modal status → noop (modal owns its own escape)', () => {
      expect(
        decideExitAction(
          input({
            key: 'ctrl-c',
            status: 'modal',
          }),
        ),
      ).toEqual({
        kind: 'noop',
      });
    });

    test('custom doublePressWindowMs honored', () => {
      const window = 300;
      expect(
        decideExitAction(
          input({
            key: 'ctrl-c',
            status: 'idle',
            pendingExitArmedAt: NOW - 250,
            doublePressWindowMs: window,
          }),
        ),
      ).toEqual({
        kind: 'exit-now',
      });
      expect(
        decideExitAction(
          input({
            key: 'ctrl-c',
            status: 'idle',
            pendingExitArmedAt: NOW - 350,
            doublePressWindowMs: window,
          }),
        ),
      ).toEqual({
        kind: 'show-exit-hint',
      });
    });
  });

  describe('Escape', () => {
    test('streaming → abort-turn', () => {
      expect(
        decideExitAction(
          input({
            key: 'escape',
            status: 'streaming',
          }),
        ),
      ).toEqual({
        kind: 'abort-turn',
      });
    });

    test('idle → noop (prompt-input handles suggestions/history)', () => {
      expect(
        decideExitAction(
          input({
            key: 'escape',
            status: 'idle',
          }),
        ),
      ).toEqual({
        kind: 'noop',
      });
    });

    test('escape never arms or fires the exit hint', () => {
      expect(
        decideExitAction(
          input({
            key: 'escape',
            status: 'idle',
            pendingExitArmedAt: NOW - 100,
          }),
        ),
      ).toEqual({
        kind: 'noop',
      });
    });
  });

  describe('Ctrl+D', () => {
    test('non-empty buffer → noop (delete-forward owned elsewhere)', () => {
      expect(
        decideExitAction(
          input({
            key: 'ctrl-d',
            status: 'idle',
            inputBufferEmpty: false,
          }),
        ),
      ).toEqual({
        kind: 'noop',
      });
    });

    test('empty buffer, idle, not armed → show-exit-hint', () => {
      expect(
        decideExitAction(
          input({
            key: 'ctrl-d',
            status: 'idle',
            inputBufferEmpty: true,
          }),
        ),
      ).toEqual({
        kind: 'show-exit-hint',
      });
    });

    test('empty buffer, idle, armed within window → exit-now', () => {
      expect(
        decideExitAction(
          input({
            key: 'ctrl-d',
            status: 'idle',
            inputBufferEmpty: true,
            pendingExitArmedAt: NOW - 100,
          }),
        ),
      ).toEqual({
        kind: 'exit-now',
      });
    });

    test('streaming, empty buffer → abort-turn', () => {
      expect(
        decideExitAction(
          input({
            key: 'ctrl-d',
            status: 'streaming',
            inputBufferEmpty: true,
          }),
        ),
      ).toEqual({
        kind: 'abort-turn',
      });
    });
  });
});
