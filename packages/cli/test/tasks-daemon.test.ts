import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireDaemonLock, reserveDaemonStart } from '../src/daemon-runtime/lock.js';

describe('daemon-runtime lock', () => {
  test('singleton lock allows only one active daemon', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-daemon-'));
    const paths = {
      dir,
      lockPath: join(dir, 'daemon.lock'),
      pidPath: join(dir, 'daemon.pid'),
      socketPath: join(dir, 'daemon.sock'),
    };

    expect(acquireDaemonLock(process.pid, paths)).toBe(true);
    expect(acquireDaemonLock(process.pid, paths)).toBe(false);
  });

  test('reserved startup blocks a second simulated launcher until child claims lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-daemon-'));
    const paths = {
      dir,
      lockPath: join(dir, 'daemon.lock'),
      pidPath: join(dir, 'daemon.pid'),
      socketPath: join(dir, 'daemon.sock'),
    };
    const parentPid = process.pid;

    const token = reserveDaemonStart(parentPid, paths);
    expect(token).toBeTruthy();
    expect(reserveDaemonStart(parentPid, paths)).toBe(null);
    expect(acquireDaemonLock(parentPid, paths, token ?? undefined)).toBe(true);
    expect(acquireDaemonLock(parentPid, paths)).toBe(false);
  });
});
