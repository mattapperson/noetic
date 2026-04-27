import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireTasksDaemonLock,
  reserveTasksDaemonStart,
} from '../src/commands/builtins/tasks/daemon.js';

describe('tasks daemon', () => {
  test('singleton lock allows only one active daemon', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-tasks-daemon-'));
    const paths = {
      dir,
      lockPath: join(dir, 'daemon.lock'),
      pidPath: join(dir, 'daemon.pid'),
      socketPath: join(dir, 'daemon.sock'),
    };

    expect(acquireTasksDaemonLock(process.pid, paths)).toBe(true);
    expect(acquireTasksDaemonLock(process.pid, paths)).toBe(false);
  });

  test('reserved startup blocks a second simulated launcher until child claims lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-tasks-daemon-'));
    const paths = {
      dir,
      lockPath: join(dir, 'daemon.lock'),
      pidPath: join(dir, 'daemon.pid'),
      socketPath: join(dir, 'daemon.sock'),
    };
    const parentPid = process.pid;

    const token = reserveTasksDaemonStart(parentPid, paths);
    expect(token).toBeTruthy();
    expect(reserveTasksDaemonStart(parentPid, paths)).toBe(null);
    expect(acquireTasksDaemonLock(parentPid, paths, token ?? undefined)).toBe(true);
    expect(acquireTasksDaemonLock(parentPid, paths)).toBe(false);
  });
});
