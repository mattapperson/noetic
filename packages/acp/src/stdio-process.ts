import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';

/** Close our pipes even when a descendant inherited them and refuses to exit. */
export async function stopProcess(child: ChildProcess, pid: number | undefined): Promise<void> {
  // Reap an exited leader before signalling its group; macOS can reject signals
  // while the last member is a zombie. A surviving descendant still keeps the group.
  if (child.stdout?.readableEnded) {
    await waitForExit(child);
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  if (!pid || pid <= 0) {
    return;
  }
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await killWindowsTree(pid);
    return;
  }
  if (!signalGroup(pid, 'SIGTERM')) {
    return;
  }
  await wait(300);
  signalGroup(pid, 'SIGKILL');
  await Promise.all([
    waitForExit(child),
    waitForGroup(pid),
  ]);
}

async function waitForGroup(pid: number): Promise<void> {
  const deadline = Date.now() + 300;
  while (Date.now() < deadline && signalGroup(pid, 0)) {
    await wait(10);
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ESRCH') {
        return false;
      }
      // A just-killed group may contain only zombies pending reaping on macOS.
      if (signal === 0 && error.code === 'EPERM') {
        return true;
      }
    }
    throw error;
  }
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
    }, 1_000);
    killer.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    killer.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`taskkill failed with exit code ${code}.`));
        return;
      }
      resolve();
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      child.removeListener('exit', done);
      resolve();
    };
    const timer = setTimeout(done, 300);
    child.once('exit', done);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
