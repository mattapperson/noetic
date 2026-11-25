/**
 * Stopping a stdio agent's whole process tree.
 *
 * Agents are often launched through a wrapper (`npx`, a Node launcher that
 * `spawnSync`s a native binary), so killing the immediate child leaves the
 * real agent running with our pipes inherited — and the host never exits. The
 * transport therefore starts each agent as the leader of its own process group
 * and stops the group: SIGTERM, a grace period, then SIGKILL. On Windows the
 * tree is stopped with `taskkill /T /F`.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';

//#region Constants

/** How long a group has to exit after SIGTERM before it is killed. */
export const TERM_GRACE_MS = 2e3;
/** How long to wait for the group to vanish after SIGKILL, and for taskkill. */
const KILL_WAIT_MS = 1e3;
const POLL_MS = 20;

//#endregion

//#region Helpers

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Wait (bounded) for the child itself to exit and be reaped. */
function waitForExit(child: ChildProcess, ms: number): Promise<void> {
  if (exited(child)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      child.removeListener('exit', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    child.once('exit', done);
  });
}

/**
 * Signal a process group. False when the group no longer exists. A group whose
 * only members are zombies awaiting reaping answers EPERM to a probe on macOS;
 * that still counts as present.
 */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) {
      throw error;
    }
    if (error.code === 'ESRCH') {
      return false;
    }
    if (error.code === 'EPERM' && signal === 0) {
      return true;
    }
    throw error;
  }
}

/** Poll until the group is gone or `ms` passes. True when it is gone. */
async function waitForGroup(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (signalGroup(pid, 0)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await wait(POLL_MS);
  }
  return true;
}

function killWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const killer = spawn(
      'taskkill',
      [
        '/pid',
        String(pid),
        '/T',
        '/F',
      ],
      {
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    const timer = setTimeout(() => {
      killer.kill();
      reject(new Error('Timed out stopping the ACP process tree.'));
    }, KILL_WAIT_MS);
    killer.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    killer.once('exit', (code) => {
      clearTimeout(timer);
      // 128: no such process — the tree had already exited.
      if (code !== 0 && code !== 128) {
        reject(new Error(`taskkill failed with exit code ${code}.`));
        return;
      }
      resolve();
    });
  });
}

//#endregion

//#region Public API

/** Options for {@link stopProcessTree}. */
export interface StopProcessTreeOptions {
  /** Grace period between SIGTERM and SIGKILL. Default {@link TERM_GRACE_MS}. */
  graceMs?: number;
}

/**
 * Stop the child's process group (POSIX) or process tree (Windows): end its
 * stdin, SIGTERM, up to `graceMs` for it to exit, then SIGKILL. Then release
 * our ends of the pipes, which a descendant that left the group (`setsid`)
 * may still hold — such a descendant must manage its own lifetime. Bounded
 * throughout, so an uncooperative child cannot hang the host.
 */
export async function stopProcessTree(
  child: ChildProcess,
  opts: StopProcessTreeOptions = {},
): Promise<void> {
  try {
    await signalTree(child, opts.graceMs ?? TERM_GRACE_MS);
  } finally {
    child.stdin?.destroy();
    child.stdout?.destroy();
  }
}

async function signalTree(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid;
  // Reap a leader whose stdout already ended before signalling its group:
  // macOS can refuse signals to a group whose last member is a zombie.
  if (child.stdout?.readableEnded) {
    await waitForExit(child, POLL_MS * 10);
  }
  child.stdin?.end();
  if (!pid || pid <= 0) {
    return;
  }
  if (process.platform === 'win32') {
    if (exited(child)) {
      return;
    }
    await killWindowsTree(pid);
    return;
  }
  if (!signalGroup(pid, 'SIGTERM')) {
    return;
  }
  if (await waitForGroup(pid, graceMs)) {
    await waitForExit(child, KILL_WAIT_MS);
    return;
  }
  signalGroup(pid, 'SIGKILL');
  await Promise.all([
    waitForExit(child, KILL_WAIT_MS),
    waitForGroup(pid, KILL_WAIT_MS),
  ]);
}

//#endregion
