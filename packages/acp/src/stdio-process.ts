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

/** @public How long a group has to exit after SIGTERM before it is killed. */
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
 * What signalling a process group found: `sent`; `gone` (ESRCH — no such
 * group); or `zombie` (EPERM — on macOS a group whose only member is an exited
 * leader not yet reaped refuses signals).
 */
type GroupSignal = 'sent' | 'gone' | 'zombie';

function signalGroup(pid: number, signal: NodeJS.Signals | 0): GroupSignal {
  try {
    process.kill(-pid, signal);
    return 'sent';
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) {
      throw error;
    }
    if (error.code === 'ESRCH') {
      return 'gone';
    }
    if (error.code === 'EPERM') {
      return 'zombie';
    }
    throw error;
  }
}

/** Poll until the group is gone or `ms` passes. True when it is gone. */
async function waitForGroup(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (signalGroup(pid, 0) !== 'gone') {
    if (Date.now() >= deadline) {
      return false;
    }
    await wait(POLL_MS);
  }
  return true;
}

/**
 * Signal the group, reaping an exited leader first when the group refuses
 * signals. False when there is nothing left to signal.
 */
async function signalLiveGroup(
  child: ChildProcess,
  pid: number,
  signal: NodeJS.Signals,
): Promise<boolean> {
  const first = signalGroup(pid, signal);
  if (first !== 'zombie') {
    return first === 'sent' || signalChild(child, signal);
  }
  await waitForExit(child, KILL_WAIT_MS);
  // Still refused once the leader is reaped: no member we may signal remains.
  return signalGroup(pid, signal) === 'sent';
}

/**
 * A child that was not started as a group leader has no group to signal; stop
 * the child itself rather than leave it running.
 */
function signalChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (exited(child)) {
    return false;
  }
  return child.kill(signal);
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

/** @public Options for {@link stopProcessTree}. */
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
 *
 * For a host that spawns its own agent process (a sandbox-wrapped command, a
 * transport that rewrites lines): spawn it with `detached: true` on POSIX so it
 * leads its own group, and call this from the transport's `close()`.
 * @public
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
    // Even when the child itself exited, its descendants may not have:
    // taskkill answers 128 when there is nothing left.
    await killWindowsTree(pid);
    return;
  }
  if (!(await signalLiveGroup(child, pid, 'SIGTERM'))) {
    return;
  }
  const groupGone = await waitForGroup(pid, graceMs);
  // A child that is not a group leader has no group to watch: it gets the
  // kill wait as its grace period.
  await waitForExit(child, groupGone ? KILL_WAIT_MS : 0);
  if (groupGone && exited(child)) {
    return;
  }
  await signalLiveGroup(child, pid, 'SIGKILL');
  await Promise.all([
    waitForExit(child, KILL_WAIT_MS),
    waitForGroup(pid, KILL_WAIT_MS),
  ]);
}

//#endregion
