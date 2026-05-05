/**
 * Local subprocess adapter durability:
 *
 *   1. Spawn a real `bun` child, persist a manifest, drop the adapter,
 *      construct a new adapter instance with the same storage, and verify
 *      `listLive` / `reattach` both rebind to the live process.
 *   2. After the child is gone, a subsequent reattach returns null and
 *      the stale manifest is swept.
 *
 * The test is intentionally self-cleaning — every spawned child is killed
 * in `afterEach` so a failing assertion never leaks processes.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  createLocalSubprocessAdapter,
  defaultProcessSignaller,
} from '../../src/adapters/local-subprocess-adapter';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { SubprocessHandle } from '../../src/types/subprocess-adapter';

const spawnedPids = new Set<number>();

afterEach(() => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  spawnedPids.clear();
});

/**
 * Launch a long-running `bun` child that keeps the event loop pinned via
 * `setInterval`. Returns the live handle; the test is responsible for
 * stopping the process (afterEach sweeps any leaked pids).
 */
async function spawnLongLivedBunChild(
  adapter: ReturnType<typeof createLocalSubprocessAdapter>,
): Promise<SubprocessHandle> {
  const handle = await adapter.spawn({
    kind: 'process',
    command: 'bun',
    args: [
      'run',
      '-e',
      'setInterval(() => {}, 1e3); process.stdout.write("up\\n");',
    ],
    detached: false,
  });
  if (typeof handle.metadata?.pid === 'number') {
    spawnedPids.add(handle.metadata.pid);
  }
  return handle;
}

describe('local adapter durability + reattach', () => {
  it('without storage: reattach returns null and listLive only sees in-memory handles', async () => {
    const adapter = createLocalSubprocessAdapter();
    expect(await adapter.reattach('nothing')).toBeNull();
    // Empty on a fresh adapter with nothing spawned.
    expect((await adapter.listLive()).length).toBe(0);
  });

  it('with storage: a live child is rediscovered by a fresh adapter via listLive + reattach', async () => {
    const storage = createInMemoryStorage();
    const first = createLocalSubprocessAdapter({
      storage,
    });
    const spawned = await spawnLongLivedBunChild(first);
    expect(spawned.status).toBe('running');
    const pid = spawned.metadata?.pid;
    expect(typeof pid).toBe('number');

    // Simulate parent restart.
    const second = createLocalSubprocessAdapter({
      storage,
    });
    const live = await second.listLive();
    expect(live.length).toBe(1);
    expect(live[0]?.id).toBe(spawned.id);
    expect(live[0]?.metadata?.pid).toBe(pid);

    const rebound = await second.reattach(spawned.id);
    expect(rebound).not.toBeNull();
    expect(rebound?.id).toBe(spawned.id);
    expect(rebound?.status).toBe('running');

    // Stop via the new adapter; the pid should go.
    if (typeof pid === 'number') {
      await second.stop(spawned.id, 'test-complete');
      // Give SIGTERM a moment to settle.
      await new Promise((r) => setTimeout(r, 5e1));
      expect(defaultProcessSignaller.isAlive(pid)).toBe(false);
      spawnedPids.delete(pid);
    }
  });

  it('reattach returns null when the child has exited (pid gone)', async () => {
    const storage = createInMemoryStorage();
    const first = createLocalSubprocessAdapter({
      storage,
    });
    const spawned = await spawnLongLivedBunChild(first);
    const pid = spawned.metadata?.pid;
    expect(typeof pid).toBe('number');

    // Kill the child and wait for it to be really gone.
    if (typeof pid === 'number') {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone already */
      }
      spawnedPids.delete(pid);
      for (let i = 0; i < 20; i++) {
        if (!defaultProcessSignaller.isAlive(pid)) {
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(defaultProcessSignaller.isAlive(pid)).toBe(false);
    }

    // Fresh adapter should sweep the stale manifest.
    const second = createLocalSubprocessAdapter({
      storage,
    });
    const rebound = await second.reattach(spawned.id);
    expect(rebound).toBeNull();
  });
});
