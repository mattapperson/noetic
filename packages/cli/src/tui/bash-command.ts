/**
 * Local bash-command execution for `!`-prefixed or auto-detected user input.
 *
 * Bypasses the agent's Bash tool validator — the user typed the command
 * directly, so we trust it. A size cap and timeout are kept as guardrails
 * so a runaway command can't pin the UI or blow up the next model turn.
 *
 * `cd` is handled in-process (a subshell can't persist cwd), updating a
 * session-scoped `effectiveCwd` held by the caller.
 */

import type { ShellAdapter } from '@noetic-tools/core';
import type { ErrorEntry, SystemEntry } from './item-utils';

export type { CdFailure, CdResult, CdSuccess, HandleCdArgs } from '../tools/cd-helper';
export { handleCd, parseCdArg } from '../tools/cd-helper';
export { getFirstCommand } from '../tools/security';

//#region Types

export interface LocalBashResult {
  /** The command as the user typed it (or the canonical `cd <path>` form). */
  command: string;
  /** Combined stdout+stderr in arrival order, truncated with an elision marker. */
  output: string;
  /** Process exit code; null if the adapter didn't report one (e.g. killed). */
  exitCode: number | null;
  /** True if the output buffer hit `maxBytes` and was head+tail truncated. */
  truncated: boolean;
  /** True if the command was killed because it exceeded `timeoutSeconds`. */
  timedOut: boolean;
}

export interface RunUserShellArgs {
  shell: ShellAdapter;
  cwd: string;
  command: string;
  /** Seconds before the command is killed. Default: 60. */
  timeoutSeconds?: number;
  /** Max captured bytes before head+tail truncation. Default: 32 KiB. */
  maxBytes?: number;
}

//#endregion

//#region Constants

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_BYTES = 32 * 1024;
const ELISION_MARKER = '\n\n[... output truncated ...]\n\n';

//#endregion

//#region Shell execution

/**
 * Execute a user-typed shell command without the agent Bash tool's validator.
 * Captures combined stdout+stderr in arrival order; truncates to `maxBytes`
 * with a head+tail elision; kills at `timeoutSeconds`.
 */
export async function runUserShellCommand(args: RunUserShellArgs): Promise<LocalBashResult> {
  const { shell, cwd, command } = args;
  const timeoutSeconds = args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;

  const collector = new OutputCollector(maxBytes);
  const abortController = new AbortController();
  let timedOut = false;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutSeconds * 1e3);

  try {
    // No `timeout:` field — the adapter would install its own kill timer that
    // races our abort signal and can leave `timedOut` false even when we
    // fired. The signal already triggers the adapter's kill path.
    const result = await shell.exec(command, {
      cwd,
      signal: abortController.signal,
      onData: (data) => {
        collector.push(data);
      },
    });

    return {
      command,
      output: collector.toString(),
      exitCode: result.exitCode,
      truncated: collector.truncated,
      timedOut,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Fixed-size head+tail buffer. Keeps the first `maxBytes / 2` and the last
 * `maxBytes / 2` bytes; emits an elision marker between them on readout.
 */
class OutputCollector {
  private readonly head: Buffer[] = [];
  private readonly tail: Buffer[] = [];
  private readonly halfMax: number;
  private headBytes = 0;
  private tailBytes = 0;
  truncated = false;

  constructor(maxBytes: number) {
    this.halfMax = Math.max(1, Math.floor(maxBytes / 2));
  }

  push(chunk: Buffer): void {
    if (this.headBytes < this.halfMax) {
      const room = this.halfMax - this.headBytes;
      if (chunk.length <= room) {
        this.head.push(chunk);
        this.headBytes += chunk.length;
        return;
      }
      this.head.push(chunk.subarray(0, room));
      this.headBytes = this.halfMax;
      this.pushTail(chunk.subarray(room));
      return;
    }
    this.pushTail(chunk);
  }

  private pushTail(chunk: Buffer): void {
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > this.halfMax && this.tail.length > 1) {
      this.truncated = true;
      const removed = this.tail.shift();
      if (removed) {
        this.tailBytes -= removed.length;
      }
    }
    if (this.tailBytes > this.halfMax && this.tail.length === 1) {
      this.truncated = true;
      const only = this.tail[0];
      this.tail[0] = only.subarray(only.length - this.halfMax);
      this.tailBytes = this.halfMax;
    }
  }

  toString(): string {
    const headText = Buffer.concat(this.head).toString('utf-8');
    if (!this.truncated) {
      return headText;
    }
    const tailText = Buffer.concat(this.tail).toString('utf-8');
    return headText + ELISION_MARKER + tailText;
  }
}

//#endregion

//#region Entry builders

/** Render a `LocalBashResult` as a system entry for the transcript. */
export function buildBashCommandEntry(result: LocalBashResult): SystemEntry {
  const lines: string[] = [];
  lines.push(`$ ${result.command}`);
  if (result.output.length > 0) {
    lines.push(result.output.replace(/\n+$/, ''));
  }
  if (result.timedOut) {
    lines.push('(timed out)');
  }
  const exit = result.exitCode === null ? '?' : String(result.exitCode);
  lines.push(`(exit ${exit})`);
  return {
    role: 'system',
    type: 'info',
    content: lines.join('\n'),
  };
}

/** Render a cd success as a system entry. */
export function buildCdEntry(newCwd: string): SystemEntry {
  return {
    role: 'system',
    type: 'info',
    content: `cd ${newCwd}`,
  };
}

/** Render a cd error (or any local-shell error) as an error entry. */
export function buildCdErrorEntry(message: string): ErrorEntry {
  return {
    role: 'system',
    type: 'error',
    content: message,
  };
}

/**
 * One-time notice rendered the first time the user runs `cd`. The cwd is
 * shared between `!` / shortcut commands and the agent's own tools.
 */
export function buildCdSplitNoticeEntry(): SystemEntry {
  return {
    role: 'system',
    type: 'info',
    content: "cd updates cwd for both your local commands and the agent's tools.",
  };
}

//#endregion

//#region Model-facing formatting

/**
 * Wrap a `LocalBashResult` as a `<local-command-stdout>` block for the next
 * model turn. The surrounding `<local-command-caveat>` is emitted once by
 * the caller, not per-block.
 */
export function formatLocalStdoutBlock(result: LocalBashResult): string {
  const attrs = [
    `command=${JSON.stringify(result.command)}`,
  ];
  attrs.push(`exit=${JSON.stringify(result.exitCode === null ? '?' : String(result.exitCode))}`);
  if (result.truncated) {
    attrs.push('truncated="true"');
  }
  if (result.timedOut) {
    attrs.push('timed_out="true"');
  }
  const body = result.output.length > 0 ? result.output : '(no output)';
  return `<local-command-stdout ${attrs.join(' ')}>\n${body}\n</local-command-stdout>`;
}

export const LOCAL_COMMAND_CAVEAT =
  '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>';

/**
 * Build a synthetic `LocalBashResult` for an in-process `cd` so the next
 * model turn knows about the cwd change.
 */
export function buildCdBashResult(command: string, newCwd: string): LocalBashResult {
  return {
    command,
    output: `(cd) cwd is now ${newCwd}`,
    exitCode: 0,
    truncated: false,
    timedOut: false,
  };
}

//#endregion
