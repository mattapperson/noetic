import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import * as log from '../../../util/log.js';
import { cleanupMergedWorktreesForKnownProjects } from './cleanup.js';
import { openTasksDatabase } from './db/index.js';
import { tasks } from './db/schema.js';
import { reconcileTasksForProject } from './reconcile.js';

export interface TasksDaemonPaths {
  dir: string;
  lockPath: string;
  pidPath: string;
  socketPath: string;
}

const DAEMON_DIR = join(homedir(), '.noetic', 'tasks');
const DEFAULT_INTERVAL_MS = 30_000;
const START_TOKEN_PREFIX = 'starting:';

export function tasksDaemonPaths(): TasksDaemonPaths {
  return {
    dir: DAEMON_DIR,
    lockPath: join(DAEMON_DIR, 'daemon.lock'),
    pidPath: join(DAEMON_DIR, 'daemon.pid'),
    socketPath: join(DAEMON_DIR, 'daemon.sock'),
  };
}

export function ensureTasksDaemon(cwd: string): void {
  const paths = tasksDaemonPaths();
  mkdirSync(paths.dir, {
    recursive: true,
  });

  if (isDaemonAlive(paths)) {
    return;
  }

  const startToken = reserveTasksDaemonStart(process.pid, paths);
  if (startToken === null) {
    return;
  }

  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) {
    releaseTasksDaemonLock(process.pid, paths, startToken);
    log.warn(
      '[tasks daemon] could not determine CLI entrypoint; background reconciliation skipped',
    );
    return;
  }

  const child = spawn(
    process.execPath,
    [
      entry,
      'tasks-daemon',
      '--cwd',
      cwd,
    ],
    {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        NOETIC_TASKS_DAEMON: '1',
        NOETIC_TASKS_DAEMON_START_TOKEN: startToken,
      },
    },
  );
  child.on('error', () => {
    releaseTasksDaemonLock(process.pid, paths, startToken);
  });
  child.unref();
}

export function acquireTasksDaemonLock(
  pid = process.pid,
  paths = tasksDaemonPaths(),
  startToken = process.env.NOETIC_TASKS_DAEMON_START_TOKEN,
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

export async function runTasksDaemon(args: {
  cwd: string;
  intervalMs?: number;
  runOnce?: boolean;
}): Promise<void> {
  const paths = tasksDaemonPaths();
  if (!acquireTasksDaemonLock(process.pid, paths)) {
    return;
  }

  const socket = await listenOnTasksDaemonSocket(paths).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[tasks daemon] socket unavailable: ${message}`);
    return null;
  });

  const cleanup = (): void => {
    socket?.close();
    tryUnlink(paths.socketPath);
    releaseTasksDaemonLock(process.pid, paths);
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  let tickRunning = false;
  const tick = async (): Promise<void> => {
    if (tickRunning) {
      return;
    }
    tickRunning = true;
    try {
      await reconcileAllKnownProjects(args.cwd);
      await cleanupMergedWorktreesForKnownProjects({
        cwd: args.cwd,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[tasks daemon] reconciliation failed: ${message}`);
    } finally {
      tickRunning = false;
    }
  };

  await tick();
  if (args.runOnce === true) {
    cleanup();
    return;
  }

  const interval = args.intervalMs ?? DEFAULT_INTERVAL_MS;
  await new Promise<never>(() => {
    setInterval(() => {
      void tick();
    }, interval);
  });
}

export async function reconcileAllKnownProjects(currentCwd: string): Promise<void> {
  const roots = knownProjectRoots(currentCwd);
  roots.add(resolve(currentCwd));
  for (const root of roots) {
    await reconcileTasksForProject(root).catch(() => undefined);
  }
}

function knownProjectRoots(cwd: string): Set<string> {
  const opened = openTasksDatabase(cwd);
  try {
    const rows = opened.db
      .select({
        projectRoot: tasks.projectRoot,
      })
      .from(tasks)
      .all();
    return new Set(rows.map((row) => resolve(row.projectRoot)));
  } finally {
    opened.close();
  }
}

function readPid(path: string): number | null {
  if (!existsSync(path)) {
    return null;
  }
  const raw = readFileSync(path, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : null;
}

export function reserveTasksDaemonStart(
  pid = process.pid,
  paths = tasksDaemonPaths(),
): string | null {
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

function releaseTasksDaemonLock(pid: number, paths: TasksDaemonPaths, token = String(pid)): void {
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

function isDaemonAlive(paths: TasksDaemonPaths): boolean {
  const pid = readPid(paths.pidPath);
  if (isPidAlive(pid)) {
    return true;
  }
  const lock = readLock(paths.lockPath);
  return (lock.kind === 'pid' || lock.kind === 'starting') && isPidAlive(lock.pid);
}

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

function readLock(path: string): LockState {
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

async function listenOnTasksDaemonSocket(paths: TasksDaemonPaths): Promise<Server> {
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

function isPidAlive(pid: number | null): boolean {
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

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    mkdirSync(dirname(path), {
      recursive: true,
    });
  }
}
