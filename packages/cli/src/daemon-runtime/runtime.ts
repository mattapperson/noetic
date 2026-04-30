import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

import * as log from '../util/log.js';
import type { JobDefinition } from './jobs.js';
import { JobScheduler } from './jobs.js';
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

export interface RunDaemonOptions {
  cwd: string;
  jobs: ReadonlyArray<JobDefinition>;
  runOnce?: boolean;
}

export async function runDaemon(opts: RunDaemonOptions): Promise<void> {
  const paths = daemonRuntimePaths();
  if (!acquireDaemonLock(process.pid, paths)) {
    return;
  }

  const socket = await listenOnDaemonSocket(paths).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[daemon] socket unavailable: ${message}`);
    return null;
  });

  const scheduler = new JobScheduler(opts.jobs, {
    cwd: opts.cwd,
  });

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    scheduler.stop();
    socket?.close();
    tryUnlink(paths.socketPath);
    releaseDaemonLock(process.pid, paths);
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

  if (opts.runOnce === true) {
    await scheduler.runOnce();
    cleanup();
    return;
  }

  await scheduler.start();
  await new Promise<never>(() => {
    // Run forever — the scheduler owns its own intervals; signal handlers cleanup.
  });
}

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
