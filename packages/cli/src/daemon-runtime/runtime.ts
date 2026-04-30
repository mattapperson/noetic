/**
 * Daemon entry — the long-lived background process that drives the
 * task-system orchestration. The daemon is one Step graph (autopilot,
 * validator, health, reconcile, events bridge) constructed by
 * {@link buildHierarchyDaemonHarness} and dispatched via
 * `harness.detachedSpawn(flow, ...)`.
 *
 * Cancellation flows through `harness.abort({ reason })` on SIGTERM/SIGINT
 * — the daemon's `every` operators are abort-aware, so the parking promise
 * resolves promptly and the fork settles.
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

import { buildHierarchyDaemonHarness } from '../commands/builtins/tasks/hierarchy/daemon-bootstrap.js';
import * as log from '../util/log.js';
import {
  acquireDaemonLock,
  DAEMON_START_TOKEN_ENV,
  isDaemonAlive,
  listenOnDaemonSocket,
  releaseDaemonLock,
  reserveDaemonStart,
  tryUnlink,
} from './lock.js';
import { daemonRuntimePaths } from './paths.js';

//#region Public API

/**
 * Acquire the singleton lock, build the daemon harness + flow, and drive the
 * whole tree to completion. SIGTERM and SIGINT trigger a graceful abort; the
 * lock is released in the `finally`.
 */
export async function runDaemon(cwd: string): Promise<void> {
  const paths = daemonRuntimePaths();
  if (!acquireDaemonLock(process.pid, paths)) {
    return;
  }

  const socket = await listenOnDaemonSocket(paths).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[daemon] socket unavailable: ${message}`);
    return null;
  });

  const { harness, flow } = buildHierarchyDaemonHarness(cwd);
  const ctx = harness.createContext({
    resourceId: 'tasks-daemon',
  });
  const handle = harness.detachedSpawn(flow, undefined, ctx);

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    socket?.close();
    tryUnlink(paths.socketPath);
    releaseDaemonLock(process.pid, paths);
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    void harness.abort({
      reason: 'sigint',
    });
  });
  process.on('SIGTERM', () => {
    void harness.abort({
      reason: 'sigterm',
    });
  });

  try {
    await handle.await();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[daemon] flow terminated: ${message}`);
  } finally {
    cleanup();
  }
}

/**
 * Spawn the daemon as a detached child process if one isn't already running.
 * Used by interactive sessions to opportunistically warm up the background
 * task orchestrator without blocking the foreground TUI.
 */
export function ensureDaemon(cwd: string): void {
  const paths = daemonRuntimePaths();
  mkdirSync(paths.dir, {
    recursive: true,
  });

  if (isDaemonAlive(paths)) {
    return;
  }

  const startToken = reserveDaemonStart(process.pid, paths);
  if (startToken === null) {
    return;
  }

  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) {
    releaseDaemonLock(process.pid, paths, startToken);
    log.warn('[daemon] could not determine CLI entrypoint; background jobs skipped');
    return;
  }

  const child = spawn(
    process.execPath,
    [
      entry,
      'daemon',
      '--cwd',
      cwd,
    ],
    {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        NOETIC_DAEMON: '1',
        [DAEMON_START_TOKEN_ENV]: startToken,
      },
    },
  );
  child.on('error', () => {
    releaseDaemonLock(process.pid, paths, startToken);
  });
  child.unref();
}

//#endregion
