import { describe, expect, mock, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import type { SuspendResumeDeps } from '../src/cli/suspend-resume.js';
import { installSuspendResumeHandlers } from '../src/cli/suspend-resume.js';

type ListenedSignal = 'SIGTSTP' | 'SIGCONT';
type RaisedSignal = 'SIGSTOP' | 'SIGCONT';

function makeDeps(): {
  deps: SuspendResumeDeps;
  registered: Map<ListenedSignal, Array<() => void>>;
  raised: RaisedSignal[];
  rawModeCalls: boolean[];
  stdout: PassThrough;
  onResume: ReturnType<typeof mock>;
} {
  const registered = new Map<ListenedSignal, Array<() => void>>();
  const raised: RaisedSignal[] = [];
  const rawModeCalls: boolean[] = [];
  const stdout = new PassThrough();
  const onResume = mock(() => {});

  const deps: SuspendResumeDeps = {
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
    raise: (signal) => {
      raised.push(signal);
    },
    stdout,
    setRawMode: (raw: boolean) => {
      rawModeCalls.push(raw);
    },
    onResume,
  };

  return {
    deps,
    registered,
    raised,
    rawModeCalls,
    stdout,
    onResume,
  };
}

function fire(registered: Map<ListenedSignal, Array<() => void>>, signal: ListenedSignal): void {
  for (const h of registered.get(signal) ?? []) {
    h();
  }
}

describe('installSuspendResumeHandlers', () => {
  test('registers SIGTSTP and SIGCONT listeners', () => {
    const { deps, registered } = makeDeps();
    installSuspendResumeHandlers(deps);
    expect(registered.get('SIGTSTP')?.length).toBe(1);
    expect(registered.get('SIGCONT')?.length).toBe(1);
  });

  test('SIGTSTP writes leave sequence, drops raw mode, raises SIGSTOP', async () => {
    const { deps, registered, raised, rawModeCalls, stdout } = makeDeps();
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(c));
    installSuspendResumeHandlers(deps);
    fire(registered, 'SIGTSTP');
    await new Promise((r) => setTimeout(r, 0));
    const written = Buffer.concat(chunks).toString('utf8');
    // Cursor visible
    expect(written).toContain('\x1b[?25h');
    // Mouse tracking off
    expect(written).toContain('\x1b[?1003l');
    expect(rawModeCalls).toEqual([
      false,
    ]);
    // Re-raise SIGSTOP so the shell job control actually suspends us.
    expect(raised).toEqual([
      'SIGSTOP',
    ]);
  });

  test('SIGCONT invokes onResume callback', () => {
    const { deps, registered, onResume } = makeDeps();
    installSuspendResumeHandlers(deps);
    fire(registered, 'SIGCONT');
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test('disposer removes both listeners', () => {
    const { deps, registered } = makeDeps();
    const dispose = installSuspendResumeHandlers(deps);
    dispose();
    expect(registered.get('SIGTSTP')?.length).toBe(0);
    expect(registered.get('SIGCONT')?.length).toBe(0);
  });

  test('idempotent: double install does not double-register', () => {
    const { deps, registered } = makeDeps();
    installSuspendResumeHandlers(deps);
    installSuspendResumeHandlers(deps);
    expect(registered.get('SIGTSTP')?.length).toBe(1);
    expect(registered.get('SIGCONT')?.length).toBe(1);
  });

  test('SIGTSTP error in stdout write does not block raise', () => {
    const base = makeDeps();
    const errStdout = new PassThrough();
    errStdout.write = () => {
      throw new Error('pipe closed');
    };
    const deps: SuspendResumeDeps = {
      ...base.deps,
      stdout: errStdout,
    };
    installSuspendResumeHandlers(deps);
    fire(base.registered, 'SIGTSTP');
    expect(base.rawModeCalls).toEqual([
      false,
    ]);
    expect(base.raised).toEqual([
      'SIGSTOP',
    ]);
  });

  test('multiple SIGCONT cycles call onResume each time', () => {
    const { deps, registered, onResume } = makeDeps();
    installSuspendResumeHandlers(deps);
    fire(registered, 'SIGCONT');
    fire(registered, 'SIGCONT');
    fire(registered, 'SIGCONT');
    expect(onResume).toHaveBeenCalledTimes(3);
  });
});
