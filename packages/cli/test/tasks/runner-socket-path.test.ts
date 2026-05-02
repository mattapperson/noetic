import { describe, expect, it } from 'bun:test';
import { runnerSocketPath } from '../../src/commands/builtins/tasks/paths.js';

const MACOS_SOCKET_PATH_LIMIT_BYTES = 104;

describe('runnerSocketPath', () => {
  const baseArgs = {
    projectRoot: '/Users/mattapperson/Development/noetic/packages/cli',
    taskId: 'T-iy9LrtX6ct',
    role: 'planner',
    runnerId: 'planner',
  } as const;

  it('defaults to <projectRoot>/.noetic/tasks/<taskId>/sockets/<role>-<runnerId>.sock', () => {
    const prev = process.env.NOETIC_RUNTIME_DIR;
    delete process.env.NOETIC_RUNTIME_DIR;
    try {
      const path = runnerSocketPath(baseArgs);
      expect(path).toBe(
        '/Users/mattapperson/Development/noetic/packages/cli/.noetic/tasks/T-iy9LrtX6ct/sockets/planner-planner.sock',
      );
    } finally {
      if (prev !== undefined) {
        process.env.NOETIC_RUNTIME_DIR = prev;
      }
    }
  });

  it('relocates the socket under NOETIC_RUNTIME_DIR when set, keeping it under macOS 104-byte limit', () => {
    const prev = process.env.NOETIC_RUNTIME_DIR;
    process.env.NOETIC_RUNTIME_DIR = '/tmp/n';
    try {
      const path = runnerSocketPath(baseArgs);
      expect(path).toBe('/tmp/n/T-iy9LrtX6ct/planner-planner.sock');
      // The default path blows the macOS socket-path cap; the relocated path
      // stays well under it, which is the whole reason the env var exists.
      expect(Buffer.byteLength(path, 'utf8')).toBeLessThan(MACOS_SOCKET_PATH_LIMIT_BYTES);
    } finally {
      if (prev === undefined) {
        delete process.env.NOETIC_RUNTIME_DIR;
      } else {
        process.env.NOETIC_RUNTIME_DIR = prev;
      }
    }
  });

  it('treats an empty NOETIC_RUNTIME_DIR as unset', () => {
    const prev = process.env.NOETIC_RUNTIME_DIR;
    process.env.NOETIC_RUNTIME_DIR = '';
    try {
      const path = runnerSocketPath(baseArgs);
      expect(path).toContain('/.noetic/tasks/T-iy9LrtX6ct/sockets/');
    } finally {
      if (prev === undefined) {
        delete process.env.NOETIC_RUNTIME_DIR;
      } else {
        process.env.NOETIC_RUNTIME_DIR = prev;
      }
    }
  });
});
