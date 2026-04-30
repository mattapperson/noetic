/**
 * After Bash `cd /tmp`, subsequent Read/Write/Edit/Ls/Grep/Find calls
 * resolve relative paths against `/tmp` rather than the factory-time cwd.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  CwdState,
  ShellAdapter,
  ShellExecOptions,
  ShellExecResult,
  ToolExecutionContext,
} from '@noetic/core';
import { createLocalFsAdapter } from '@noetic/core';
import type { BashOutput } from '../src/tools/bash.js';
import { BashOutputSchema, createBashTool } from '../src/tools/bash.js';
import { createEditTool } from '../src/tools/edit.js';
import { createLsTool } from '../src/tools/ls.js';
import { createReadTool } from '../src/tools/read.js';
import { createWriteTool } from '../src/tools/write.js';

interface CtxStub {
  cwdState: CwdState;
}

function makeCtxStub(initialCwd: string): CtxStub {
  return {
    cwdState: {
      cwd: initialCwd,
    },
  };
}

function makeToolCtx(ctxStub: CtxStub): ToolExecutionContext {
  const empty: ToolExecutionContext = Object.create(null);
  Object.defineProperty(empty, 'ctx', {
    value: ctxStub,
    enumerable: true,
  });
  return empty;
}

const noopShell: ShellAdapter = {
  async exec(_command: string, _options: ShellExecOptions): Promise<ShellExecResult> {
    return {
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
  },
};

function isAsyncGenerator<O>(
  value: Promise<O> | AsyncGenerator<unknown, O>,
): value is AsyncGenerator<unknown, O> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

async function awaitToolResult<O>(result: Promise<O> | AsyncGenerator<unknown, O>): Promise<O> {
  if (!isAsyncGenerator(result)) {
    return result;
  }
  while (true) {
    const next = await result.next();
    if (next.done) {
      return next.value;
    }
  }
}

interface RunBashArgs {
  shell: ShellAdapter;
  ctxStub: CtxStub;
  command: string;
  factoryCwd: string;
}

async function runBash(args: RunBashArgs): Promise<BashOutput> {
  const tool = createBashTool(args.factoryCwd, args.shell);
  const result = await awaitToolResult(
    tool.execute(
      {
        command: args.command,
      },
      makeToolCtx(args.ctxStub),
    ),
  );
  return BashOutputSchema.parse(result);
}

describe('Tools follow Bash cd', () => {
  test('Read after Bash cd resolves the relative path under the new cwd', async () => {
    const launchDir = mkdtempSync(join(tmpdir(), 'follow-launch-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'follow-target-'));
    writeFileSync(join(targetDir, 'note.txt'), 'hello from target');

    const ctxStub = makeCtxStub(launchDir);
    const fs = createLocalFsAdapter();

    const cdResult = await runBash({
      shell: noopShell,
      ctxStub,
      command: `cd ${targetDir}`,
      factoryCwd: launchDir,
    });
    expect(cdResult.exitCode).toBe(0);
    expect(ctxStub.cwdState.cwd).toBe(targetDir);

    const read = createReadTool(launchDir, fs);
    const out = await awaitToolResult(
      read.execute(
        {
          path: 'note.txt',
        },
        makeToolCtx(ctxStub),
      ),
    );
    expect(out.content).toContain('hello from target');
  });

  test('Write after Bash cd creates a file under the new cwd', async () => {
    const launchDir = mkdtempSync(join(tmpdir(), 'follow-write-launch-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'follow-write-target-'));
    const ctxStub = makeCtxStub(launchDir);
    const fs = createLocalFsAdapter();

    await runBash({
      shell: noopShell,
      ctxStub,
      command: `cd ${targetDir}`,
      factoryCwd: launchDir,
    });

    const write = createWriteTool(launchDir, fs);
    const out = await awaitToolResult(
      write.execute(
        {
          path: 'created.txt',
          content: 'written under target',
        },
        makeToolCtx(ctxStub),
      ),
    );
    expect(out.success).toBe(true);

    const read = createReadTool(targetDir, fs);
    const back = await awaitToolResult(
      read.execute(
        {
          path: 'created.txt',
        },
        makeToolCtx({
          cwdState: {
            cwd: targetDir,
          },
        }),
      ),
    );
    expect(back.content).toContain('written under target');
  });

  test('Edit after Bash cd resolves the relative path under the new cwd', async () => {
    const launchDir = mkdtempSync(join(tmpdir(), 'follow-edit-launch-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'follow-edit-target-'));
    writeFileSync(join(targetDir, 'mut.txt'), 'before');

    const ctxStub = makeCtxStub(launchDir);
    const fs = createLocalFsAdapter();

    await runBash({
      shell: noopShell,
      ctxStub,
      command: `cd ${targetDir}`,
      factoryCwd: launchDir,
    });

    const edit = createEditTool(launchDir, fs);
    const out = await awaitToolResult(
      edit.execute(
        {
          path: 'mut.txt',
          oldText: 'before',
          newText: 'after',
        },
        makeToolCtx(ctxStub),
      ),
    );
    expect(out.success).toBe(true);

    const read = createReadTool(targetDir, fs);
    const verify = await awaitToolResult(
      read.execute(
        {
          path: 'mut.txt',
        },
        makeToolCtx({
          cwdState: {
            cwd: targetDir,
          },
        }),
      ),
    );
    expect(verify.content).toContain('after');
  });

  test('Ls after Bash cd lists entries under the new cwd', async () => {
    const launchDir = mkdtempSync(join(tmpdir(), 'follow-ls-launch-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'follow-ls-target-'));
    mkdirSync(join(targetDir, 'sub'));
    writeFileSync(join(targetDir, 'a.txt'), 'a');

    const ctxStub = makeCtxStub(launchDir);
    const fs = createLocalFsAdapter();

    await runBash({
      shell: noopShell,
      ctxStub,
      command: `cd ${targetDir}`,
      factoryCwd: launchDir,
    });

    const ls = createLsTool(launchDir, fs);
    const out = await awaitToolResult(ls.execute({}, makeToolCtx(ctxStub)));
    expect(out.path).toBe(resolve(targetDir));
    expect(out.entries).toContain('a.txt');
    expect(out.entries).toContain('sub/');
  });
});
