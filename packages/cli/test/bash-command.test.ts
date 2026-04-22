/**
 * Unit tests for local bash-command execution (src/tui/bash-command.ts).
 *
 * Uses a synthetic ShellAdapter to drive the runner deterministically —
 * no real shell is spawned.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShellAdapter, ShellExecOptions, ShellExecResult } from '@noetic/core';

import {
  buildBashCommandEntry,
  buildCdBashResult,
  buildCdSplitNoticeEntry,
  firstToken,
  formatLocalStdoutBlock,
  handleCd,
  parseCdArg,
  runUserShellCommand,
} from '../src/tui/bash-command.js';

//#region ShellAdapter helpers

interface StubShellOptions {
  /** Output chunks to deliver via onData. */
  chunks?: ReadonlyArray<string>;
  exitCode?: number | null;
  /** Delay in ms before the command "completes"; honors signal aborts. */
  delayMs?: number;
}

function stubShell(opts: StubShellOptions = {}): {
  shell: ShellAdapter;
  calls: Array<{
    command: string;
    options: ShellExecOptions;
  }>;
} {
  const calls: Array<{
    command: string;
    options: ShellExecOptions;
  }> = [];
  const shell: ShellAdapter = {
    async exec(command, options): Promise<ShellExecResult> {
      calls.push({
        command,
        options,
      });
      for (const chunk of opts.chunks ?? []) {
        options.onData?.(Buffer.from(chunk, 'utf-8'));
      }
      // Mirror the real adapter: on abort, resolve (don't throw). The
      // adapter's `proc.kill()` makes the stream end naturally; `exec`
      // returns with whatever exit code the runtime reported.
      if (opts.delayMs !== undefined && opts.delayMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, opts.delayMs);
          options.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            {
              once: true,
            },
          );
        });
      }
      return {
        stdout: (opts.chunks ?? []).join(''),
        stderr: '',
        exitCode: opts.exitCode ?? 0,
      };
    },
  };
  return {
    shell,
    calls,
  };
}

//#endregion

describe('firstToken', () => {
  test('extracts first whitespace-separated token', () => {
    expect(firstToken('cd foo')).toBe('cd');
    expect(firstToken('git   status')).toBe('git');
    expect(firstToken('  ls -la')).toBe('ls');
  });

  test('returns empty for empty or whitespace-only input', () => {
    expect(firstToken('')).toBe('');
    expect(firstToken('   ')).toBe('');
  });
});

describe('parseCdArg', () => {
  test('bare cd -> undefined', () => {
    expect(parseCdArg('cd')).toBeUndefined();
    expect(parseCdArg('cd  ')).toBeUndefined();
  });

  test('single arg', () => {
    expect(parseCdArg('cd foo')).toBe('foo');
    expect(parseCdArg('cd   /abs/path')).toBe('/abs/path');
    expect(parseCdArg('cd ..')).toBe('..');
    expect(parseCdArg('cd -')).toBe('-');
  });

  test('strips a matching pair of surrounding quotes', () => {
    expect(parseCdArg('cd "foo bar"')).toBe('foo bar');
    expect(parseCdArg("cd 'foo bar'")).toBe('foo bar');
  });

  test('returns undefined for non-cd commands', () => {
    expect(parseCdArg('ls foo')).toBeUndefined();
    expect(parseCdArg('cdr foo')).toBeUndefined();
  });
});

describe('handleCd', () => {
  let tmpRoot: string;
  let subdir: string;
  let filePath: string;
  const fakeHome = '/tmp/fake-home-for-tests';

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'noetic-cd-'));
    subdir = join(tmpRoot, 'sub');
    mkdirSync(subdir);
    filePath = join(tmpRoot, 'a-file.txt');
    writeFileSync(filePath, 'hi');
    mkdirSync(fakeHome, {
      recursive: true,
    });
  });

  afterAll(() => {
    rmSync(tmpRoot, {
      recursive: true,
      force: true,
    });
    rmSync(fakeHome, {
      recursive: true,
      force: true,
    });
  });

  test('bare cd goes to home', () => {
    const result = handleCd({
      arg: undefined,
      effectiveCwd: tmpRoot,
      prevCwd: null,
      home: fakeHome,
    });
    expect(result).toEqual({
      kind: 'ok',
      previousCwd: tmpRoot,
      newCwd: fakeHome,
    });
  });

  test('~ alone goes to home', () => {
    const result = handleCd({
      arg: '~',
      effectiveCwd: tmpRoot,
      prevCwd: null,
      home: fakeHome,
    });
    expect(result).toEqual({
      kind: 'ok',
      previousCwd: tmpRoot,
      newCwd: fakeHome,
    });
  });

  test('~/sub expands', () => {
    mkdirSync(join(fakeHome, 'nested'), {
      recursive: true,
    });
    const result = handleCd({
      arg: '~/nested',
      effectiveCwd: tmpRoot,
      prevCwd: null,
      home: fakeHome,
    });
    assert(result.kind === 'ok');
    expect(result.newCwd).toBe(join(fakeHome, 'nested'));
  });

  test('absolute path resolves', () => {
    const result = handleCd({
      arg: subdir,
      effectiveCwd: tmpRoot,
      prevCwd: null,
      home: fakeHome,
    });
    expect(result).toEqual({
      kind: 'ok',
      previousCwd: tmpRoot,
      newCwd: subdir,
    });
  });

  test('relative path resolves against effectiveCwd', () => {
    const result = handleCd({
      arg: 'sub',
      effectiveCwd: tmpRoot,
      prevCwd: null,
      home: fakeHome,
    });
    expect(result).toEqual({
      kind: 'ok',
      previousCwd: tmpRoot,
      newCwd: subdir,
    });
  });

  test('cd - returns previous cwd', () => {
    const result = handleCd({
      arg: '-',
      effectiveCwd: subdir,
      prevCwd: tmpRoot,
      home: fakeHome,
    });
    expect(result).toEqual({
      kind: 'ok',
      previousCwd: subdir,
      newCwd: tmpRoot,
    });
  });

  test('cd - with no prevCwd errors', () => {
    const result = handleCd({
      arg: '-',
      effectiveCwd: tmpRoot,
      prevCwd: null,
      home: fakeHome,
    });
    assert(result.kind === 'error');
    expect(result.message).toMatch(/OLDPWD/);
  });

  test('nonexistent directory errors', () => {
    const result = handleCd({
      arg: join(tmpRoot, 'does-not-exist'),
      effectiveCwd: tmpRoot,
      prevCwd: null,
      home: fakeHome,
    });
    assert(result.kind === 'error');
    expect(result.message).toMatch(/no such file or directory/);
  });

  test('path that is a file (not dir) errors', () => {
    const result = handleCd({
      arg: filePath,
      effectiveCwd: tmpRoot,
      prevCwd: null,
      home: fakeHome,
    });
    assert(result.kind === 'error');
    expect(result.message).toMatch(/not a directory/);
  });
});

describe('runUserShellCommand', () => {
  test('captures combined output and exit code', async () => {
    const { shell, calls } = stubShell({
      chunks: [
        'hello\n',
        'world\n',
      ],
      exitCode: 0,
    });

    const result = await runUserShellCommand({
      shell,
      cwd: '/tmp',
      command: 'echo hi',
    });

    expect(result.command).toBe('echo hi');
    expect(result.output).toBe('hello\nworld\n');
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('echo hi');
    expect(calls[0].options.cwd).toBe('/tmp');
  });

  test('propagates non-zero exit', async () => {
    const { shell } = stubShell({
      chunks: [
        'oops\n',
      ],
      exitCode: 2,
    });
    const result = await runUserShellCommand({
      shell,
      cwd: '/tmp',
      command: 'false',
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toBe('oops\n');
  });

  test('truncates with head+tail elision when maxBytes is exceeded', async () => {
    const chunks = [
      'A'.repeat(20),
      'B'.repeat(20),
      'C'.repeat(20),
    ];
    const { shell } = stubShell({
      chunks,
      exitCode: 0,
    });

    const result = await runUserShellCommand({
      shell,
      cwd: '/tmp',
      command: 'noise',
      maxBytes: 20,
    });

    expect(result.truncated).toBe(true);
    expect(result.output).toMatch(/output truncated/);
    expect(result.output.startsWith('AAAA')).toBe(true);
    expect(result.output.endsWith('CC\n') || result.output.endsWith('CC')).toBe(true);
  });

  test('times out with timedOut: true when command exceeds timeoutSeconds', async () => {
    const { shell } = stubShell({
      chunks: [
        'partial\n',
      ],
      delayMs: 2e3,
      exitCode: 0,
    });

    const start = Date.now();
    const result = await runUserShellCommand({
      shell,
      cwd: '/tmp',
      command: 'sleep 2',
      timeoutSeconds: 0.05,
    });

    expect(result.timedOut).toBe(true);
    expect(result.output).toBe('partial\n');
    // Should abort well under the stub's 2000ms delay.
    expect(Date.now() - start).toBeLessThan(1500);
  });
});

describe('entry + model formatting', () => {
  test('buildBashCommandEntry renders $-prefixed command and exit code', () => {
    const entry = buildBashCommandEntry({
      command: 'ls',
      output: 'a\nb\n',
      exitCode: 0,
      truncated: false,
      timedOut: false,
    });
    expect(entry.role).toBe('system');
    expect(entry.type).toBe('info');
    expect(entry.content).toBe('$ ls\na\nb\n(exit 0)');
  });

  test('buildBashCommandEntry notes timeout and unknown exit', () => {
    const entry = buildBashCommandEntry({
      command: 'sleep 99',
      output: '',
      exitCode: null,
      truncated: false,
      timedOut: true,
    });
    expect(entry.content).toBe('$ sleep 99\n(timed out)\n(exit ?)');
  });

  test('formatLocalStdoutBlock wraps output with command/exit attrs', () => {
    const block = formatLocalStdoutBlock({
      command: 'ls',
      output: 'a\n',
      exitCode: 0,
      truncated: false,
      timedOut: false,
    });
    expect(block).toContain('command="ls"');
    expect(block).toContain('exit="0"');
    expect(block).toContain('a\n');
    expect(block.startsWith('<local-command-stdout')).toBe(true);
    expect(block.endsWith('</local-command-stdout>')).toBe(true);
  });

  test('formatLocalStdoutBlock marks truncation and timeout', () => {
    const block = formatLocalStdoutBlock({
      command: 'noise',
      output: 'x',
      exitCode: null,
      truncated: true,
      timedOut: true,
    });
    expect(block).toContain('truncated="true"');
    expect(block).toContain('timed_out="true"');
    expect(block).toContain('exit="?"');
  });

  test('formatLocalStdoutBlock fills empty output placeholder', () => {
    const block = formatLocalStdoutBlock({
      command: 'true',
      output: '',
      exitCode: 0,
      truncated: false,
      timedOut: false,
    });
    expect(block).toContain('(no output)');
  });

  test('buildCdBashResult synthesizes a 0-exit result describing the new cwd', () => {
    const result = buildCdBashResult('cd foo', '/workspace/foo');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('/workspace/foo');
    expect(result.command).toBe('cd foo');
  });

  test('buildCdSplitNoticeEntry mentions the launch cwd', () => {
    const entry = buildCdSplitNoticeEntry('/orig');
    expect(entry.content).toContain('/orig');
    expect(entry.content).toContain('local');
  });
});
