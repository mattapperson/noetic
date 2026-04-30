import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { daemonRuntimePaths } from '../src/daemon-runtime/paths.js';

describe('daemonRuntimePaths', () => {
  test('lives under ~/.noetic/daemon and exposes lock/pid/socket files', () => {
    const paths = daemonRuntimePaths();
    const expectedDir = join(homedir(), '.noetic', 'daemon');
    expect(paths.dir).toBe(expectedDir);
    expect(paths.lockPath).toBe(join(expectedDir, 'daemon.lock'));
    expect(paths.pidPath).toBe(join(expectedDir, 'daemon.pid'));
    expect(paths.socketPath).toBe(join(expectedDir, 'daemon.sock'));
  });
});
