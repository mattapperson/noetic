export const DOUBLE_PRESS_WINDOW_MS = 800;

export type ExitActionStatus = 'idle' | 'streaming' | 'submitted' | 'modal';
export type ExitActionKey = 'escape' | 'ctrl-c' | 'ctrl-d';

export type ExitAction =
  | {
      kind: 'abort-turn';
    }
  | {
      kind: 'show-exit-hint';
    }
  | {
      kind: 'exit-now';
    }
  | {
      kind: 'noop';
    };

export type ExitActionInput = {
  key: ExitActionKey;
  status: ExitActionStatus;
  inputBufferEmpty: boolean;
  pendingExitArmedAt: number | null;
  now: number;
  doublePressWindowMs: number;
};

const ABORT: ExitAction = {
  kind: 'abort-turn',
};
const HINT: ExitAction = {
  kind: 'show-exit-hint',
};
const EXIT: ExitAction = {
  kind: 'exit-now',
};
const NOOP: ExitAction = {
  kind: 'noop',
};

function isTurnInFlight(status: ExitActionStatus): boolean {
  return status === 'streaming' || status === 'submitted';
}

function withinWindow(input: ExitActionInput): boolean {
  if (input.pendingExitArmedAt === null) {
    return false;
  }
  const elapsed = input.now - input.pendingExitArmedAt;
  return elapsed >= 0 && elapsed <= input.doublePressWindowMs;
}

function decideEscape(input: ExitActionInput): ExitAction {
  if (isTurnInFlight(input.status)) {
    return ABORT;
  }
  return NOOP;
}

function decideExit(input: ExitActionInput): ExitAction {
  if (input.status === 'modal') {
    return NOOP;
  }
  if (isTurnInFlight(input.status)) {
    return ABORT;
  }
  if (withinWindow(input)) {
    return EXIT;
  }
  return HINT;
}

function decideCtrlD(input: ExitActionInput): ExitAction {
  if (!input.inputBufferEmpty) {
    return NOOP;
  }
  return decideExit(input);
}

export function decideExitAction(input: ExitActionInput): ExitAction {
  if (input.key === 'escape') {
    return decideEscape(input);
  }
  if (input.key === 'ctrl-c') {
    return decideExit(input);
  }
  return decideCtrlD(input);
}
