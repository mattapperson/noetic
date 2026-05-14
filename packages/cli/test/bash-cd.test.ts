/**
 * Tests for the agent Bash tool's in-process `cd` interception.
 *
 * `cd <path>` is short-circuited: it never spawns a shell, mutates the
 * Context's `cwdState`, and returns a synthetic BashOutput. Compound forms
 * (`cd foo && ls`) still go through the shell.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  CwdState,
  ShellAdapter,
  ShellExecOptions,
  ShellExecResult,
  ToolExecutionContext,
} from '@noetic-tools/core';
import type { BashOutput } from '../src/tools/bash.js';
import { BashOutputSchema, createBashTool } from '../src/tools/bash.js';

interface CtxStub {
  cwdState: CwdState;
}

function makeCtxStub(initialCwd: string, previousCwd?: string): CtxStub {
  return {
    cwdState: {
      cwd: initialCwd,
      previousCwd,
    },
  };
}

/**
 * Build a minimal ToolExecutionContext for the cd code path. The Bash tool
 * only reads `toolCtx.ctx.cwdState`; other fields are unused on this path.
 * Object.create(null) returns `any`, so the annotation works without a cast.
 */
function makeToolCtx(ctxStub: CtxStub): ToolExecutionContext {
  const empty: ToolExecutionContext = Object.create(null);
  Object.defineProperty(empty, 'ctx', {
    value: ctxStub,
    enumerable: true,
  });
  return empty;
}

function isAsyncGenerator<O>(
  value: Promise<O> | AsyncGenerator<unknown, O>,
): value is AsyncGenerator<unknown, O> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

interface RunArgs {
  shell: ShellAdapter;
  ctxStub: CtxStub;
  command: string;
  factoryCwd?: string;
}

async function runBashCd(args: RunArgs): Promise<BashOutput> {
  const tool = createBashTool(args.factoryCwd ?? args.ctxStub.cwdState.cwd, args.shell);
  const exec = tool.execute(
    {
      command: args.command,
    },
    makeToolCtx(args.ctxStub),
  );
  if (!isAsyncGenerator(exec)) {
    return BashOutputSchema.parse(await exec);
  }
  while (true) {
    const next = await exec.next();
    if (next.done) {
      return BashOutputSchema.parse(next.value);
    }
  }
}

const noopShell: ShellAdapter = {
  async exec(): Promise<ShellExecResult> {
    return {
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
  },
};

interface ShellRecord {
  command?: string;
  cwd?: string;
}

function recordingShell(record: ShellRecord): ShellAdapter {
  return {
    async exec(command: string, options: ShellExecOptions): Promise<ShellExecResult> {
      record.command = command;
      record.cwd = options.cwd;
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    },
  };
}

describe('Bash cd interception', () => {
  test('cd to absolute path mutates cwdState and returns success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-cd-abs-'));
    const ctxStub = makeCtxStub('/somewhere');
    const result = await runBashCd({
      shell: noopShell,
      ctxStub,
      command: `cd ${dir}`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('cwd is now');
    expect(result.output).toContain(dir);
    expect(ctxStub.cwdState.cwd).toBe(dir);
    expect(ctxStub.cwdState.previousCwd).toBe('/somewhere');
  });

  test('cd to relative path resolves against current cwd', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'bash-cd-rel-'));
    const subDir = mkdtempSync(join(baseDir, 'child-'));
    const ctxStub = makeCtxStub(baseDir);
    const subdirName = subDir.slice(baseDir.length + 1);
    const result = await runBashCd({
      shell: noopShell,
      ctxStub,
      command: `cd ${subdirName}`,
    });
    expect(result.exitCode).toBe(0);
    expect(ctxStub.cwdState.cwd).toBe(resolve(baseDir, subdirName));
  });

  test('cd - returns to previousCwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-cd-back-'));
    const ctxStub = makeCtxStub(dir, '/tmp');
    const result = await runBashCd({
      shell: noopShell,
      ctxStub,
      command: 'cd -',
    });
    expect(result.exitCode).toBe(0);
    expect(ctxStub.cwdState.cwd).toBe('/tmp');
    expect(ctxStub.cwdState.previousCwd).toBe(dir);
  });

  test('bare cd goes to home', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-cd-home-'));
    const ctxStub = makeCtxStub(dir);
    const result = await runBashCd({
      shell: noopShell,
      ctxStub,
      command: 'cd',
    });
    expect(result.exitCode).toBe(0);
    expect(ctxStub.cwdState.cwd).toBe(homedir());
  });

  test('cd . preserves previousCwd so cd - still works afterward', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-cd-noop-'));
    const ctxStub: CtxStub = {
      cwdState: {
        cwd: dir,
        previousCwd: '/historic',
      },
    };
    const result = await runBashCd({
      shell: noopShell,
      ctxStub,
      command: `cd ${dir}`,
    });
    expect(result.exitCode).toBe(0);
    expect(ctxStub.cwdState.cwd).toBe(dir);
    expect(ctxStub.cwdState.previousCwd).toBe('/historic');
  });

  test('cd to nonexistent path returns error and leaves cwdState alone', async () => {
    const ctxStub = makeCtxStub('/tmp');
    const result = await runBashCd({
      shell: noopShell,
      ctxStub,
      command: 'cd /this/path/does/not/exist/anywhere',
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Error');
    expect(ctxStub.cwdState.cwd).toBe('/tmp');
    expect(ctxStub.cwdState.previousCwd).toBeUndefined();
  });

  test('compound cd command falls through to the shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-cd-compound-'));
    const ctxStub = makeCtxStub(dir);
    const record: ShellRecord = {};
    const result = await runBashCd({
      shell: recordingShell(record),
      ctxStub,
      command: 'cd && pwd',
    });
    expect(result.exitCode).toBe(0);
    expect(record.command).toBe('cd && pwd');
    expect(record.cwd).toBe(dir);
    expect(ctxStub.cwdState.cwd).toBe(dir);
  });

  test('non-cd commands pass live cwd to shell.exec', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-noncd-'));
    const ctxStub = makeCtxStub(dir);
    const record: ShellRecord = {};
    await runBashCd({
      shell: recordingShell(record),
      ctxStub,
      command: 'echo hi',
    });
    expect(record.cwd).toBe(dir);
  });
});

describe('Bash uses live cwd over factory cwd', () => {
  test('shell.exec receives live cwdState.cwd, not the factory-time cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-live-'));
    const ctxStub = makeCtxStub(dir);
    const record: ShellRecord = {};
    await runBashCd({
      shell: recordingShell(record),
      ctxStub,
      command: 'pwd',
      factoryCwd: '/launch-time-cwd',
    });
    expect(record.cwd).toBe(dir);
  });
});
