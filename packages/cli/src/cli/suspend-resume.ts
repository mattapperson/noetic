/**
 * SIGTSTP / SIGCONT (Ctrl+Z / fg) suspend & resume.
 *
 * When the user hits Ctrl+Z while the TUI is in raw mode, the kernel
 * delivers SIGTSTP. If we don't intercept, Node suspends the process
 * with raw mode and extended-input modes still on — `fg`-ing back into
 * the shell shows escape garbage and the cursor stays hidden.
 *
 * The handler:
 *   1. Emits the same terminal-restore ANSI sequence we use for SIGINT —
 *      cursor visible, mouse/Kitty/bracketed-paste off.
 *   2. Drops raw mode so the shell receives plain text input.
 *   3. Raises SIGSTOP, which is *not* caught and actually suspends.
 *
 * On SIGCONT (`fg`), the resume handler invokes `onResume`. Callers wire
 * this to whatever re-establishes their TUI state (e.g. an Ink instance's
 * `clear()` method to force a redraw).
 */

import { buildTerminalRestoreSequence } from './interrupt-safety-net.js';

export type SuspendSignal = 'SIGTSTP' | 'SIGCONT';

export type SuspendResumeDeps = {
  on: (signal: SuspendSignal, handler: () => void) => void;
  off: (signal: SuspendSignal, handler: () => void) => void;
  raise: (signal: 'SIGSTOP' | 'SIGCONT') => void;
  stdout: NodeJS.WritableStream;
  setRawMode?: (raw: boolean) => void;
  /** Called on SIGCONT after the kernel resumes the process. */
  onResume: () => void;
};

const INSTALLED = new WeakMap<
  SuspendResumeDeps,
  {
    dispose: () => void;
  }
>();

const SIGNALS: ReadonlyArray<SuspendSignal> = [
  'SIGTSTP',
  'SIGCONT',
];

export function installSuspendResumeHandlers(deps: SuspendResumeDeps): () => void {
  const existing = INSTALLED.get(deps);
  if (existing) {
    return existing.dispose;
  }

  const handlers: Array<{
    signal: SuspendSignal;
    handler: () => void;
  }> = [];

  const onTstp = (): void => {
    runSuspend(deps);
  };
  const onCont = (): void => {
    runResume(deps);
  };
  deps.on('SIGTSTP', onTstp);
  handlers.push({
    signal: 'SIGTSTP',
    handler: onTstp,
  });
  deps.on('SIGCONT', onCont);
  handlers.push({
    signal: 'SIGCONT',
    handler: onCont,
  });

  const dispose = (): void => {
    for (const { signal, handler } of handlers) {
      deps.off(signal, handler);
    }
    INSTALLED.delete(deps);
  };

  // Reference SIGNALS so static analysis sees the read of the constant
  // even when only used implicitly via the registration loop above. This
  // also keeps the public list available if we expand the signal set.
  void SIGNALS;

  INSTALLED.set(deps, {
    dispose,
  });
  return dispose;
}

function runSuspend(deps: SuspendResumeDeps): void {
  try {
    deps.stdout.write(buildTerminalRestoreSequence());
  } catch {
    // pipe closed — keep going so we still suspend
  }
  if (deps.setRawMode) {
    try {
      deps.setRawMode(false);
    } catch {
      // not a TTY or already torn down
    }
  }
  deps.raise('SIGSTOP');
}

function runResume(deps: SuspendResumeDeps): void {
  try {
    deps.onResume();
  } catch {
    // best-effort; user already resumed by hitting `fg`
  }
}
