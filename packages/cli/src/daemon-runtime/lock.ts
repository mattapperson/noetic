import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { createServer } from 'node:net';
import { dirname } from 'node:path';

import type { DaemonRuntimePaths } from './paths.js';
import { daemonRuntimePaths } from './paths.js';

export const START_TOKEN_PREFIX = 'starting:';
export const DAEMON_START_TOKEN_ENV = 'NOETIC_DAEMON_START_TOKEN';

type LockState =
  | {
      kind: 'none';
    }
  | {
      kind: 'pid';
      pid: number;
    }
  | {
      kind: 'starting';
      pid: number;
      token: string;
    }
  | {
      kind: 'stale';
    };

export function acquireDaemonLock(
  pid = process.pid,
  paths = daemonRuntimePaths(),
  startToken = process.env[DAEMON_START_TOKEN_ENV],
): boolean {
  mkdirSync(paths.dir, {
    recursive: true,
  });
  if (isPidAlive(readPid(paths.pidPath))) {
    return false;
  }

  const lock = readLock(paths.lockPath);
  if (lock.kind === 'pid' && isPidAlive(lock.pid)) {
    return false;
  }
  if (lock.kind === 'starting' && lock.token !== startToken && isPidAlive(lock.pid)) {
    return false;
  }
  if (lock.kind !== 'none' && lock.kind !== 'starting') {
    tryUnlink(paths.lockPath);
  }
  if (lock.kind === 'starting' && lock.token !== startToken) {
    tryUnlink(paths.lockPath);
  }
  tryUnlink(paths.pidPath);

  try {
    if (lock.kind === 'starting' && lock.token === startToken) {
      writeFileSync(paths.lockPath, `${pid}\n`);
    } else {
      writeFileSync(paths.lockPath, `${pid}\n`, {
        flag: 'wx',
      });
    }
    writeFileSync(paths.pidPath, `${pid}\n`);
    return true;
  } catch {
    return false;
  }
}

export function reserveDaemonStart(pid = process.pid, paths = daemonRuntimePaths()): string | null {
  mkdirSync(paths.dir, {
    recursive: true,
  });
  const token = `${START_TOKEN_PREFIX}${pid}`;
  const existing = readLock(paths.lockPath);
  if (existing.kind === 'pid' && isPidAlive(existing.pid)) {
    return null;
  }
  if (existing.kind === 'starting' && isPidAlive(existing.pid)) {
    return null;
  }
  if (existing.kind !== 'none') {
    tryUnlink(paths.lockPath);
  }
  tryUnlink(paths.pidPath);
  try {
    writeFileSync(paths.lockPath, `${token}\n`, {
      flag: 'wx',
    });
    return token;
  } catch {
    return null;
  }
}

export function releaseDaemonLock(
  pid: number,
  paths: DaemonRuntimePaths,
  token = String(pid),
): void {
  const lock = readLock(paths.lockPath);
  const ownsLock =
    (lock.kind === 'pid' && lock.pid === pid) || (lock.kind === 'starting' && lock.token === token);
  if (ownsLock) {
    tryUnlink(paths.lockPath);
  }
  if (readPid(paths.pidPath) === pid) {
    tryUnlink(paths.pidPath);
  }
}

export function isDaemonAlive(paths: DaemonRuntimePaths): boolean {
  const pid = readPid(paths.pidPath);
  if (isPidAlive(pid)) {
    return true;
  }
  const lock = readLock(paths.lockPath);
  return (lock.kind === 'pid' || lock.kind === 'starting') && isPidAlive(lock.pid);
}

export function readPid(path: string): number | null {
  if (!existsSync(path)) {
    return null;
  }
  const raw = readFileSync(path, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : null;
}

export function readLock(path: string): LockState {
  if (!existsSync(path)) {
    return {
      kind: 'none',
    };
  }
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.startsWith(START_TOKEN_PREFIX)) {
    const pid = Number.parseInt(raw.slice(START_TOKEN_PREFIX.length), 10);
    return Number.isFinite(pid)
      ? {
          kind: 'starting',
          pid,
          token: raw,
        }
      : {
          kind: 'stale',
        };
  }
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid)
    ? {
        kind: 'pid',
        pid,
      }
    : {
        kind: 'stale',
      };
}

export function isPidAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    mkdirSync(dirname(path), {
      recursive: true,
    });
  }
}

export async function listenOnDaemonSocket(paths: DaemonRuntimePaths): Promise<Server> {
  tryUnlink(paths.socketPath);
  const server = createServer((socket) => {
    socket.end('ok\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
