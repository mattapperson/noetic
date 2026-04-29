import type { ExitAction } from './exit-action.ts';

export type ExitState = {
  pendingExitArmedAt: number | null;
};

export type ExitCallbacks = {
  onAbortTurn: () => void;
  onShowHint: () => void;
  onExitGracefully: () => void;
};

export type ApplyExitDecisionInput = {
  decision: ExitAction;
  state: ExitState;
  now: number;
  callbacks: ExitCallbacks;
};

const HANDLERS: Record<ExitAction['kind'], (input: ApplyExitDecisionInput) => ExitState> = {
  'abort-turn': ({ callbacks }) => {
    callbacks.onAbortTurn();
    return {
      pendingExitArmedAt: null,
    };
  },
  'show-exit-hint': ({ callbacks, now }) => {
    callbacks.onShowHint();
    return {
      pendingExitArmedAt: now,
    };
  },
  'exit-now': ({ callbacks }) => {
    callbacks.onExitGracefully();
    return {
      pendingExitArmedAt: null,
    };
  },
  noop: ({ state }) => {
    return {
      ...state,
    };
  },
};

export function applyExitDecision(input: ApplyExitDecisionInput): ExitState {
  const handler = HANDLERS[input.decision.kind];
  return handler(input);
}

export function isExitArmedExpired(state: ExitState, now: number, windowMs: number): boolean {
  if (state.pendingExitArmedAt === null) {
    return false;
  }
  return now - state.pendingExitArmedAt > windowMs;
}
