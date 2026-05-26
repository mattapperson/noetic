/**
 * Process-level SIGINT / SIGTERM safety net.
 *
 * The TUI handles in-app Ctrl+C via `useExitOnInterrupt`. But when noetic
 * is killed externally (`kill -INT $pid`, parent shell job control, etc.),
 * the kernel delivers a real signal. With Ink configured to `exitOnCtrlC:
 * false` we no longer ride Ink's signal-handler shoulders, so we own the
 * cleanup: emit ANSI sequences to restore a sane terminal state, drop raw
 * mode, then exit with the conventional code.
 *
 * The handler is intentionally minimal — we don't try to plumb back into
 * the harness here. The harness's own AbortController gets garbage-
 * collected with the process; subprocesses owned by the bash tool already
 * receive their own SIGINT via the process group.
 */

const SHOW_CURSOR = '\x1b[?25h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';
const DISABLE_MOUSE_ANY_EVENT = '\x1b[?1003l';
const DISABLE_MOUSE_BUTTON = '\x1b[?1002l';
const DISABLE_MOUSE_NORMAL = '\x1b[?1000l';
const DISABLE_FOCUS_REPORTING = '\x1b[?1004l';
const POP_KITTY_KEYBOARD = '\x1b[<u';
const RESET_MODIFY_OTHER_KEYS = '\x1b[>4;0m';

export type Signal = 'SIGINT' | 'SIGTERM';

export type SignalDeps = {
  on: (signal: Signal, handler: () => void) => void;
  off: (signal: Signal, handler: () => void) => void;
  exit: (code: number) => never;
  stdout: NodeJS.WritableStream;
  setRawMode?: (raw: boolean) => void;
  /** Optional pre-cleanup hook (e.g. unmount Ink) — fires before terminal restore. */
  onBeforeExit?: () => void;
};

export function buildTerminalRestoreSequence(): string {
  return [
    SHOW_CURSOR,
    DISABLE_BRACKETED_PASTE,
    DISABLE_MOUSE_ANY_EVENT,
    DISABLE_MOUSE_BUTTON,
    DISABLE_MOUSE_NORMAL,
    DISABLE_FOCUS_REPORTING,
    POP_KITTY_KEYBOARD,
    RESET_MODIFY_OTHER_KEYS,
  ].join('');
}

const SIGNAL_EXIT_CODES: Record<Signal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * Install idempotent SIGINT/SIGTERM listeners.
 *
 * Returns a disposer that removes whatever this call registered. Calling
 * `installInterruptSafetyNet` twice with the same deps does NOT
 * double-register — the second call is a no-op (and its returned disposer
 * still removes the original handlers, since we track them per deps).
 */
export function installInterruptSafetyNet(deps: SignalDeps): () => void {
  if (INSTALLED.has(deps)) {
    const installed = INSTALLED.get(deps);
    if (installed) {
      return installed.dispose;
    }
  }

  const handlers: Array<{
    signal: Signal;
    handler: () => void;
  }> = [];

  for (const signal of SIGNALS) {
    const handler = (): void => {
      runShutdown({
        deps,
        signal,
      });
    };
    deps.on(signal, handler);
    handlers.push({
      signal,
      handler,
    });
  }

  const dispose = (): void => {
    for (const { signal, handler } of handlers) {
      deps.off(signal, handler);
    }
    INSTALLED.delete(deps);
  };

  INSTALLED.set(deps, {
    dispose,
  });
  return dispose;
}

const SIGNALS: ReadonlyArray<Signal> = [
  'SIGINT',
  'SIGTERM',
];
const INSTALLED = new WeakMap<
  SignalDeps,
  {
    dispose: () => void;
  }
>();

function runShutdown(args: { deps: SignalDeps; signal: Signal }): never {
  const { deps, signal } = args;
  if (deps.onBeforeExit) {
    try {
      deps.onBeforeExit();
    } catch {
      // best-effort; we still want to restore terminal + exit
    }
  }
  try {
    deps.stdout.write(buildTerminalRestoreSequence());
  } catch {
    // pipe may already be closed; nothing to do
  }
  if (deps.setRawMode) {
    try {
      deps.setRawMode(false);
    } catch {
      // not a TTY or already torn down
    }
  }
  return deps.exit(SIGNAL_EXIT_CODES[signal]);
}
