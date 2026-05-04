import { describe, expect, it } from 'bun:test';
import { DEFAULT_RUNTIME_DIR, runnerSocketPath } from '../../src/commands/builtins/tasks/paths.js';

const MACOS_SOCKET_PATH_LIMIT_BYTES = 104;

describe('runnerSocketPath', () => {
  const implementerArgs = {
    role: 'implementer',
    runnerId: 'F-T3UNKqDHar',
  } as const;
  const plannerArgs = {
    role: 'planner',
    runnerId: 'T-iy9LrtX6ct',
  } as const;

  it('defaults to /tmp/.noetic/<role>-<runnerId>.sock', () => {
    const prev = process.env.NOETIC_RUNTIME_DIR;
    delete process.env.NOETIC_RUNTIME_DIR;
    try {
      expect(runnerSocketPath(implementerArgs)).toBe(
        `${DEFAULT_RUNTIME_DIR}/implementer-F-T3UNKqDHar.sock`,
      );
      expect(runnerSocketPath(plannerArgs)).toBe(
        `${DEFAULT_RUNTIME_DIR}/planner-T-iy9LrtX6ct.sock`,
      );
    } finally {
      if (prev !== undefined) {
        process.env.NOETIC_RUNTIME_DIR = prev;
      }
    }
  });

  it('keeps the default under the macOS 104-byte socket-path limit', () => {
    const prev = process.env.NOETIC_RUNTIME_DIR;
    delete process.env.NOETIC_RUNTIME_DIR;
    try {
      const path = runnerSocketPath(implementerArgs);
      expect(Buffer.byteLength(path, 'utf8')).toBeLessThan(MACOS_SOCKET_PATH_LIMIT_BYTES);
    } finally {
      if (prev !== undefined) {
        process.env.NOETIC_RUNTIME_DIR = prev;
      }
    }
  });

  it('relocates the socket under NOETIC_RUNTIME_DIR when set', () => {
    const prev = process.env.NOETIC_RUNTIME_DIR;
    process.env.NOETIC_RUNTIME_DIR = '/tmp/n';
    try {
      expect(runnerSocketPath(plannerArgs)).toBe('/tmp/n/planner-T-iy9LrtX6ct.sock');
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
      expect(runnerSocketPath(plannerArgs)).toBe(
        `${DEFAULT_RUNTIME_DIR}/planner-T-iy9LrtX6ct.sock`,
      );
    } finally {
      if (prev === undefined) {
        delete process.env.NOETIC_RUNTIME_DIR;
      } else {
        process.env.NOETIC_RUNTIME_DIR = prev;
      }
    }
  });
});
