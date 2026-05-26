/**
 * Unit tests for the agent Bash tool (src/tools/bash.ts).
 *
 * Drives the tool with a synthetic ShellAdapter so we can deterministically
 * test alt-screen detection, timeout propagation, and interactive rejection
 * without spawning real processes.
 */

import { describe, expect, test } from 'bun:test';
import type {
  ShellAdapter,
  ShellExecOptions,
  ShellExecResult,
  ToolExecutionContext,
} from '@noetic-tools/core';
import type { BashOutput } from '../src/tools/bash.js';
import { BashOutputSchema, createBashTool } from '../src/tools/bash.js';

function makeStubExecutionContext(): ToolExecutionContext {
  const empty: ToolExecutionContext = Object.create(null);
  return empty;
}

function isAsyncGenerator<O>(
  value: Promise<O> | AsyncGenerator<unknown, O>,
): value is AsyncGenerator<unknown, O> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

//#region Helpers

interface StubOptions {
  chunks?: ReadonlyArray<string>;
  exitCode?: number | null;
  /** When true, reject with `timeout:N` matching the requested timeout. */
  rejectAsTimeout?: boolean;
  /** Delay (ms) before resolution; ignored when rejecting. */
  delayMs?: number;
}

function stubShell(opts: StubOptions = {}): ShellAdapter {
  return {
    async exec(_command: string, options: ShellExecOptions): Promise<ShellExecResult> {
      for (const chunk of opts.chunks ?? []) {
        options.onData?.(Buffer.from(chunk, 'utf-8'));
        // Yield so abort signals can fire between chunks if the tool aborts.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (options.signal?.aborted) {
          break;
        }
      }
      if (opts.delayMs && !options.signal?.aborted) {
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
      if (opts.rejectAsTimeout) {
        throw new Error(`timeout:${options.timeout ?? 0}`);
      }
      return {
        stdout: '',
        stderr: '',
        exitCode: opts.exitCode ?? 0,
      };
    },
  };
}

async function runBash(
  shell: ShellAdapter,
  command: string,
  timeout?: number,
): Promise<BashOutput> {
  const tool = createBashTool('/tmp', shell);
  const exec = tool.execute(
    {
      command,
      timeout,
    },
    makeStubExecutionContext(),
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

//#endregion

describe('Bash tool — interactive rejection', () => {
  test('rejects vim before invoking the shell', async () => {
    let invoked = false;
    const shell: ShellAdapter = {
      async exec(): Promise<ShellExecResult> {
        invoked = true;
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
        };
      },
    };
    const result = await runBash(shell, 'vim foo.txt');
    expect(invoked).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.output).toContain('interactive');
    expect(result.output).toContain('vim');
  });
});

describe('Bash tool — alt-screen detection', () => {
  test('aborts and returns an error when the process enters alt-screen', async () => {
    const shell = stubShell({
      // Tiny custom TUI: emit alt-screen entry, then hang.
      chunks: [
        `${String.fromCharCode(27)}[?1049h`,
        'should-not-arrive',
      ],
      delayMs: 5e3,
      exitCode: null,
    });
    const result = await runBash(shell, 'mytui');
    expect(result.cancelled).toBe(true);
    expect(result.output).toContain('alternate-screen');
    expect(result.output).toContain('Interactive');
  });

  test('detects the legacy 1047h alt-screen sequence', async () => {
    const shell = stubShell({
      chunks: [
        `${String.fromCharCode(27)}[?1047h`,
      ],
      delayMs: 5e3,
    });
    const result = await runBash(shell, 'legacy');
    expect(result.cancelled).toBe(true);
    expect(result.output).toContain('alternate-screen');
  });

  test('does not trigger on regular ANSI color codes', async () => {
    const shell = stubShell({
      chunks: [
        `${String.fromCharCode(27)}[31mred${String.fromCharCode(27)}[0m\n`,
      ],
      exitCode: 0,
    });
    const result = await runBash(shell, 'echo colored');
    expect(result.cancelled).toBe(false);
    expect(result.output).toContain('red');
  });
});

describe('Bash tool — timeout propagation', () => {
  test('returns a structured timeout error when the adapter throws timeout:N', async () => {
    const shell = stubShell({
      chunks: [
        'partial output\n',
      ],
      rejectAsTimeout: true,
    });
    const result = await runBash(shell, 'sleep 10', 5);
    expect(result.cancelled).toBe(false);
    expect(result.output).toContain('timed out');
    expect(result.output).toContain('5');
    expect(result.output).toContain('partial output');
  });
});
