/**
 * pidStarttime drift detection in the local adapter's reattach path.
 *
 * We inject a stub `ProcessSignaller` so we can simulate the recycled-pid
 * scenario deterministically without racing the OS to hand us the same
 * pid twice. The invariant under test: a recorded `pidStarttime` that
 * no longer matches the live start time for that pid MUST cause
 * `reattach` to return null and MUST sweep the stale manifest.
 */

import { describe, expect, it } from 'bun:test';
import type {
  CreateLocalSubprocessAdapterOptions,
  ProcessSignaller,
  SubprocessSignal,
} from '../../src/adapters/local-subprocess-adapter';
import { createLocalSubprocessAdapter } from '../../src/adapters/local-subprocess-adapter';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';

interface StubState {
  alivePids: Set<number>;
  startTimes: Map<number, string>;
}

function buildStubSignaller(state: StubState): ProcessSignaller {
  return {
    kill(_target: number, _signal: SubprocessSignal) {
      /* no-op — tests drive state directly */
    },
    isAlive(pid) {
      return state.alivePids.has(pid);
    },
    startTime(pid) {
      return state.startTimes.get(pid) ?? null;
    },
  };
}

/**
 * Stub spawn fn that returns a controllable fake child with a stable pid
 * per test so drift scenarios can be scripted. Only the handful of fields
 * the adapter reads (`pid`, `unref`, `stdin/stdout/stderr`, `on` overloads)
 * need to be present.
 */
function buildStubSpawnFn(pid: number): CreateLocalSubprocessAdapterOptions['spawnFn'] {
  function on(event: 'error', listener: (err: Error) => void): unknown;
  function on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  function on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  function on(_event: string, _listener: unknown): unknown {
    return undefined;
  }
  return () => ({
    pid,
    stdin: null,
    stdout: null,
    stderr: null,
    unref: () => {},
    on,
  });
}

describe('local adapter pidStarttime drift', () => {
  it('reattach returns null when pid is alive but pidStarttime no longer matches', async () => {
    const state: StubState = {
      alivePids: new Set([
        4242,
      ]),
      startTimes: new Map([
        [
          4242,
          'Mon May 04 12:00:00 2026',
        ],
      ]),
    };
    const storage = createInMemoryStorage();
    const first = createLocalSubprocessAdapter({
      storage,
      signaller: buildStubSignaller(state),
      spawnFn: buildStubSpawnFn(4242),
    });
    const handle = await first.spawn({
      kind: 'process',
      command: 'fake',
      args: [],
    });
    expect(handle.metadata?.pid).toBe(4242);
    expect(handle.metadata?.pidStarttime).toBe('Mon May 04 12:00:00 2026');

    // Simulate recycle: same pid, different start time.
    state.startTimes.set(4242, 'Mon May 04 13:00:00 2026');

    const second = createLocalSubprocessAdapter({
      storage,
      signaller: buildStubSignaller(state),
    });
    const rebound = await second.reattach(handle.id);
    expect(rebound).toBeNull();
    // Stale manifest should be swept; a third adapter should see no
    // stale entries.
    const third = createLocalSubprocessAdapter({
      storage,
      signaller: buildStubSignaller(state),
    });
    expect((await third.listLive()).length).toBe(0);
  });

  it('reattach rebinds successfully when pid and pidStarttime both still match', async () => {
    const state: StubState = {
      alivePids: new Set([
        9191,
      ]),
      startTimes: new Map([
        [
          9191,
          'Mon May 04 12:00:00 2026',
        ],
      ]),
    };
    const storage = createInMemoryStorage();
    const first = createLocalSubprocessAdapter({
      storage,
      signaller: buildStubSignaller(state),
      spawnFn: buildStubSpawnFn(9191),
    });
    const handle = await first.spawn({
      kind: 'process',
      command: 'fake',
      args: [],
    });

    // State unchanged — process is the same.
    const second = createLocalSubprocessAdapter({
      storage,
      signaller: buildStubSignaller(state),
    });
    const rebound = await second.reattach(handle.id);
    expect(rebound).not.toBeNull();
    expect(rebound?.id).toBe(handle.id);
    expect(rebound?.metadata?.pid).toBe(9191);
  });

  it('listLive filters out manifests whose pids are no longer alive', async () => {
    const state: StubState = {
      alivePids: new Set([
        1111,
      ]),
      startTimes: new Map([
        [
          1111,
          't0',
        ],
      ]),
    };
    const storage = createInMemoryStorage();
    const adapter1 = createLocalSubprocessAdapter({
      storage,
      signaller: buildStubSignaller(state),
      spawnFn: buildStubSpawnFn(1111),
    });
    const h1 = await adapter1.spawn({
      kind: 'process',
      command: 'fake',
      args: [],
    });
    expect(h1.metadata?.pid).toBe(1111);

    // Kill it off-stage.
    state.alivePids.delete(1111);
    state.startTimes.delete(1111);

    // Fresh adapter sees no live handles.
    const adapter2 = createLocalSubprocessAdapter({
      storage,
      signaller: buildStubSignaller(state),
    });
    expect((await adapter2.listLive()).length).toBe(0);
  });
});
