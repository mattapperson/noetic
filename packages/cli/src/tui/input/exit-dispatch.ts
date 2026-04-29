import type { ExitAction } from './exit-action.js';

export type ExitState = {
  pendingExitArmedAt: number | null;
};

export type ApplyExitDecisionInput = {
  decision: ExitAction;
  state: ExitState;
  now: number;
};

export type DispatchResult = {
  nextState: ExitState;
  /**
   * The action kind to fire as a side effect. Callers wire this to their
   * own callbacks (`onAbortTurn`, `onExitGracefully`) — keeping it out of
   * this reducer makes the function pure and safe to call inside React's
   * state-updater path.
   */
  fire: ExitAction['kind'];
};

const HANDLERS: Record<ExitAction['kind'], (input: ApplyExitDecisionInput) => ExitState> = {
  'abort-turn': () => ({
    pendingExitArmedAt: null,
  }),
  'show-exit-hint': ({ now }) => ({
    pendingExitArmedAt: now,
  }),
  'exit-now': () => ({
    pendingExitArmedAt: null,
  }),
  noop: ({ state }) => ({
    ...state,
  }),
};

export function applyExitDecision(input: ApplyExitDecisionInput): DispatchResult {
  const handler = HANDLERS[input.decision.kind];
  return {
    nextState: handler(input),
    fire: input.decision.kind,
  };
}

export function isExitArmedExpired(state: ExitState, now: number, windowMs: number): boolean {
  if (state.pendingExitArmedAt === null) {
    return false;
  }
  return now - state.pendingExitArmedAt > windowMs;
}
