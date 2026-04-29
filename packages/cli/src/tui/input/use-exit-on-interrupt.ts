import type { Key } from 'ink';
import { useInput } from 'ink';
import { useEffect, useState } from 'react';
import type { ExitActionKey, ExitActionStatus } from './exit-action.js';
import { DOUBLE_PRESS_WINDOW_MS, decideExitAction } from './exit-action.js';
import type { ExitState } from './exit-dispatch.js';
import { applyExitDecision } from './exit-dispatch.js';

export type UseExitOnInterruptOptions = {
  status: ExitActionStatus;
  inputBufferEmpty: boolean;
  doublePressWindowMs?: number;
  /**
   * Subset of keys this hook handles. Keys outside this set are ignored, so
   * other listeners (e.g. prompt-input's Escape handler) keep working
   * without double-firing. Defaults to all three.
   */
  enabledKeys?: ReadonlyArray<ExitActionKey>;
  onAbortTurn: () => void;
  onExitGracefully: () => void;
};

export type UseExitOnInterruptResult = {
  isHintArmed: boolean;
};

export function mapInkKeyToExitKey(
  input: string,
  key: Pick<Key, 'escape' | 'ctrl'>,
  enabledKeys?: ReadonlyArray<ExitActionKey>,
): ExitActionKey | null {
  const matched = matchInkKey(input, key);
  if (matched === null) {
    return null;
  }
  if (enabledKeys && !enabledKeys.includes(matched)) {
    return null;
  }
  return matched;
}

function matchInkKey(input: string, key: Pick<Key, 'escape' | 'ctrl'>): ExitActionKey | null {
  if (key.escape) {
    return 'escape';
  }
  if (key.ctrl && input === 'c') {
    return 'ctrl-c';
  }
  if (key.ctrl && input === 'd') {
    return 'ctrl-d';
  }
  return null;
}

export function useExitOnInterrupt(opts: UseExitOnInterruptOptions): UseExitOnInterruptResult {
  const windowMs = opts.doublePressWindowMs ?? DOUBLE_PRESS_WINDOW_MS;
  const [state, setState] = useState<ExitState>({
    pendingExitArmedAt: null,
  });

  useInput((input, key) => {
    const exitKey = mapInkKeyToExitKey(input, key, opts.enabledKeys);
    if (!exitKey) {
      return;
    }
    setState((prev) => {
      const now = Date.now();
      const decision = decideExitAction({
        key: exitKey,
        status: opts.status,
        inputBufferEmpty: opts.inputBufferEmpty,
        pendingExitArmedAt: prev.pendingExitArmedAt,
        now,
        doublePressWindowMs: windowMs,
      });
      return applyExitDecision({
        decision,
        state: prev,
        now,
        callbacks: {
          onAbortTurn: opts.onAbortTurn,
          onExitGracefully: opts.onExitGracefully,
          onShowHint: () => {},
        },
      });
    });
  });

  useEffect(() => {
    if (state.pendingExitArmedAt === null) {
      return;
    }
    const armedAt = state.pendingExitArmedAt;
    const timer = setTimeout(() => {
      setState((prev) => {
        if (prev.pendingExitArmedAt !== armedAt) {
          return prev;
        }
        return {
          pendingExitArmedAt: null,
        };
      });
    }, windowMs);
    return () => {
      clearTimeout(timer);
    };
  }, [
    state.pendingExitArmedAt,
    windowMs,
  ]);

  return {
    isHintArmed: state.pendingExitArmedAt !== null,
  };
}
