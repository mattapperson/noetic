import { describe, expect, it } from 'bun:test';
import { execTolerantOfMissing, isShellMissing } from '@noetic-tools/code-agent/tasks/worktree-node';
import type { ShellAdapter } from '@noetic-tools/core';

describe('isShellMissing', () => {
  it('returns true on exit 127 regardless of stderr', () => {
    expect(
      isShellMissing({
        stdout: '',
        stderr: '',
        exitCode: 127,
      }),
    ).toBe(true);
  });

  it('returns true when stderr matches "command not found"', () => {
    expect(
      isShellMissing({
        stdout: '',
        stderr: 'sh: 1: wt: command not found',
        exitCode: 1,
      }),
    ).toBe(true);
    // Case-insensitive — sandboxes may emit the message in different casings.
    expect(
      isShellMissing({
        stdout: '',
        stderr: 'WT: COMMAND NOT FOUND',
        exitCode: 1,
      }),
    ).toBe(true);
  });

  it('returns true when stderr matches "no such file or directory"', () => {
    expect(
      isShellMissing({
        stdout: '',
        stderr: 'spawn: no such file or directory',
        exitCode: 2,
      }),
    ).toBe(true);
  });

  it('returns false on a genuine non-zero exit with unrelated stderr', () => {
    expect(
      isShellMissing({
        stdout: '',
        stderr: 'CONFLICT (content): merge conflict',
        exitCode: 1,
      }),
    ).toBe(false);
  });

  it('returns false on a successful exit', () => {
    expect(
      isShellMissing({
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
      }),
    ).toBe(false);
  });

  it('returns false when exit code is null (signal-killed)', () => {
    expect(
      isShellMissing({
        stdout: '',
        stderr: '',
        exitCode: null,
      }),
    ).toBe(false);
  });
});

describe('execTolerantOfMissing', () => {
  it('returns the shell result verbatim on a normal call', async () => {
    const shell: ShellAdapter = {
      async exec() {
        return {
          stdout: 'hello',
          stderr: '',
          exitCode: 0,
        };
      },
    };
    const result = await execTolerantOfMissing(shell, 'echo hello', '/repo');
    expect(result).toEqual({
      stdout: 'hello',
      stderr: '',
      exitCode: 0,
    });
  });

  it('normalises an ENOENT-throw into a synthetic exit 127 result', async () => {
    const shell: ShellAdapter = {
      async exec() {
        const err: NodeJS.ErrnoException = new Error('spawn wt ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
    };
    const result = await execTolerantOfMissing(shell, 'wt merge x', '/repo');
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT');
  });

  it('rethrows errors that lack a code property', async () => {
    // Plain Error with ENOENT in the message but no .code field is a
    // semantic mismatch — caller probably means a real failure, not a
    // missing binary. We rely on the structural code check.
    const messageOnly = new Error('spawn wt ENOENT');
    const shell: ShellAdapter = {
      async exec() {
        throw messageOnly;
      },
    };
    await expect(execTolerantOfMissing(shell, 'wt merge x', '/repo')).rejects.toBe(messageOnly);
  });

  it('rethrows errors with a non-ENOENT code unchanged', async () => {
    const eaccess: NodeJS.ErrnoException = new Error('permission denied');
    eaccess.code = 'EACCES';
    const shell: ShellAdapter = {
      async exec() {
        throw eaccess;
      },
    };
    await expect(execTolerantOfMissing(shell, 'wt merge x', '/repo')).rejects.toBe(eaccess);
  });

  it('rethrows non-ENOENT errors unchanged', async () => {
    const original = new Error('AbortError: signal');
    const shell: ShellAdapter = {
      async exec() {
        throw original;
      },
    };
    await expect(execTolerantOfMissing(shell, 'true', '/repo')).rejects.toBe(original);
  });

  it('threads cwd through to shell.exec', async () => {
    let receivedCwd = '';
    const shell: ShellAdapter = {
      async exec(_command, options) {
        receivedCwd = options.cwd;
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
        };
      },
    };
    await execTolerantOfMissing(shell, 'pwd', '/some/where');
    expect(receivedCwd).toBe('/some/where');
  });
});
