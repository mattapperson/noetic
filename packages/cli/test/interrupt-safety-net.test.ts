import { describe, expect, mock, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import type { SignalDeps } from '../src/cli/interrupt-safety-net.js';
import {
  buildTerminalRestoreSequence,
  installInterruptSafetyNet,
} from '../src/cli/interrupt-safety-net.js';

type Signal = 'SIGINT' | 'SIGTERM';

function makeDeps(): {
  deps: SignalDeps;
  registered: Map<Signal, Array<() => void>>;
  exitCalls: number[];
  rawModeCalls: boolean[];
  stdout: PassThrough;
} {
  const registered = new Map<Signal, Array<() => void>>();
  const exitCalls: number[] = [];
  const rawModeCalls: boolean[] = [];
  const stdout = new PassThrough();

  const deps: SignalDeps = {
    on: (signal, handler) => {
      const list = registered.get(signal) ?? [];
      list.push(handler);
      registered.set(signal, list);
    },
    off: (signal, handler) => {
      const list = registered.get(signal) ?? [];
      registered.set(
        signal,
        list.filter((h) => h !== handler),
      );
    },
    exit: (code: number): never => {
      exitCalls.push(code);
      throw new Error('__exit__');
    },
    stdout,
    setRawMode: (raw: boolean) => {
      rawModeCalls.push(raw);
    },
  };

  return {
    deps,
    registered,
    exitCalls,
    rawModeCalls,
    stdout,
  };
}

function fireSignal(
  registered: Map<Signal, Array<() => void>>,
  signal: Signal,
): {
  errored: boolean;
} {
  const handlers = registered.get(signal) ?? [];
  try {
    for (const h of handlers) {
      h();
    }
    return {
      errored: false,
    };
  } catch (err) {
    if (err instanceof Error && err.message === '__exit__') {
      return {
        errored: true,
      };
    }
    throw err;
  }
}

describe('buildTerminalRestoreSequence', () => {
  test('restores cursor and disables alternate input modes', () => {
    const seq = buildTerminalRestoreSequence();
    // Cursor visible (DECTCEM show)
    expect(seq).toContain('\x1b[?25h');
    // Bracketed paste off
    expect(seq).toContain('\x1b[?2004l');
    // Mouse tracking off (any-event)
    expect(seq).toContain('\x1b[?1003l');
    // Kitty keyboard protocol pop
    expect(seq).toContain('\x1b[<u');
  });
});

describe('installInterruptSafetyNet', () => {
  test('registers handlers for SIGINT and SIGTERM', () => {
    const { deps, registered } = makeDeps();
    installInterruptSafetyNet(deps);
    expect(registered.get('SIGINT')?.length).toBe(1);
    expect(registered.get('SIGTERM')?.length).toBe(1);
  });

  test('SIGINT writes restore sequence, drops raw mode, exits 130', async () => {
    const { deps, registered, exitCalls, rawModeCalls, stdout } = makeDeps();
    const chunks: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    installInterruptSafetyNet(deps);
    fireSignal(registered, 'SIGINT');
    await new Promise((r) => setTimeout(r, 0));
    const written = Buffer.concat(chunks).toString('utf8');
    expect(written).toContain('\x1b[?25h');
    expect(rawModeCalls).toEqual([
      false,
    ]);
    expect(exitCalls).toEqual([
      130,
    ]);
  });

  test('SIGTERM exits 143', () => {
    const { deps, registered, exitCalls } = makeDeps();
    installInterruptSafetyNet(deps);
    fireSignal(registered, 'SIGTERM');
    expect(exitCalls).toEqual([
      143,
    ]);
  });

  test('idempotent: second install does not double-register', () => {
    const { deps, registered } = makeDeps();
    installInterruptSafetyNet(deps);
    installInterruptSafetyNet(deps);
    expect(registered.get('SIGINT')?.length).toBe(1);
    expect(registered.get('SIGTERM')?.length).toBe(1);
  });

  test('disposer removes listeners', () => {
    const { deps, registered } = makeDeps();
    const dispose = installInterruptSafetyNet(deps);
    dispose();
    expect(registered.get('SIGINT')?.length).toBe(0);
    expect(registered.get('SIGTERM')?.length).toBe(0);
  });

  test('runs onBeforeExit hook before terminal restore', () => {
    const { deps, registered } = makeDeps();
    const order: string[] = [];
    const onBeforeExit = mock(() => {
      order.push('hook');
    });
    deps.stdout.on('data', () => {
      order.push('stdout');
    });
    installInterruptSafetyNet({
      ...deps,
      onBeforeExit,
    });
    fireSignal(registered, 'SIGINT');
    expect(onBeforeExit).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('hook');
  });

  test('does not throw when stdout is not a TTY (no setRawMode provided)', () => {
    const { deps, registered, exitCalls } = makeDeps();
    const partial: SignalDeps = {
      on: deps.on,
      off: deps.off,
      exit: deps.exit,
      stdout: deps.stdout,
    };
    installInterruptSafetyNet(partial);
    fireSignal(registered, 'SIGINT');
    expect(exitCalls).toEqual([
      130,
    ]);
  });
});
