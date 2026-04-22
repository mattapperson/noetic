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

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import type { ShellAdapter } from '@noetic/core';

import type { ErrorEntry, SystemEntry } from './item-utils';

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

export interface HandleCdArgs {
  arg: string | undefined;
  effectiveCwd: string;
  prevCwd: string | null;
  /** Override for tests; defaults to `os.homedir()`. */
  home?: string;
}

export interface CdSuccess {
  kind: 'ok';
  previousCwd: string;
  newCwd: string;
}

export interface CdFailure {
  kind: 'error';
  message: string;
}

export type CdResult = CdSuccess | CdFailure;

//#endregion

//#region Constants

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_BYTES = 32 * 1024;
const ELISION_MARKER = '\n\n[... output truncated ...]\n\n';

//#endregion

//#region Command splitting

/**
 * Returns the first whitespace-separated token of a trimmed command string.
 * `cd foo bar` → `cd`; `git   status` → `git`; empty → `''`.
 */
export function firstToken(command: string): string {
  const trimmed = command.trimStart();
  const match = /^\S+/.exec(trimmed);
  return match ? match[0] : '';
}

/**
 * Extract the single argument to `cd` (everything after `cd` and whitespace).
 * Returns undefined for a bare `cd`. Does NOT shell-unquote — quoted paths
 * with spaces are passed through as-is; we rely on stat to catch bad paths.
 */
export function parseCdArg(command: string): string | undefined {
  const trimmed = command.trimStart();
  if (!/^cd(\s|$)/.test(trimmed)) {
    return undefined;
  }
  const rest = trimmed.slice(2).trim();
  if (rest.length === 0) {
    return undefined;
  }
  // Strip a single matched pair of surrounding quotes if present.
  if (
    (rest.startsWith('"') && rest.endsWith('"')) ||
    (rest.startsWith("'") && rest.endsWith("'"))
  ) {
    return rest.slice(1, -1);
  }
  return rest;
}

//#endregion

//#region cd handler

/**
 * Resolve a `cd` argument against the effective cwd, with ~ expansion,
 * `-` (previous) support, and existence/dir validation.
 */
export function handleCd(args: HandleCdArgs): CdResult {
  const { arg, effectiveCwd, prevCwd } = args;
  const home = args.home ?? homedir();

  const target = resolveCdTarget({
    arg,
    effectiveCwd,
    prevCwd,
    home,
  });
  if (target.kind === 'error') {
    return target;
  }

  try {
    if (!statSync(target.path).isDirectory()) {
      return {
        kind: 'error',
        message: `cd: not a directory: ${target.path}`,
      };
    }
  } catch {
    return {
      kind: 'error',
      message: `cd: no such file or directory: ${target.path}`,
    };
  }

  // No-op cd (e.g. `cd .`): preserve OLDPWD by not touching previousCwd.
  if (target.path === effectiveCwd) {
    return {
      kind: 'ok',
      previousCwd: prevCwd ?? effectiveCwd,
      newCwd: effectiveCwd,
    };
  }

  return {
    kind: 'ok',
    previousCwd: effectiveCwd,
    newCwd: target.path,
  };
}

interface CdTargetPath {
  kind: 'path';
  path: string;
}

interface ResolveCdTargetArgs {
  arg: string | undefined;
  effectiveCwd: string;
  prevCwd: string | null;
  home: string;
}

function resolveCdTarget(args: ResolveCdTargetArgs): CdTargetPath | CdFailure {
  const { arg, effectiveCwd, prevCwd, home } = args;
  if (arg === undefined) {
    return {
      kind: 'path',
      path: home,
    };
  }
  if (arg === '-') {
    if (prevCwd === null) {
      return {
        kind: 'error',
        message: 'cd: OLDPWD not set',
      };
    }
    return {
      kind: 'path',
      path: prevCwd,
    };
  }
  if (arg === '~') {
    return {
      kind: 'path',
      path: home,
    };
  }
  if (arg.startsWith('~/')) {
    return {
      kind: 'path',
      path: resolve(home, arg.slice(2)),
    };
  }
  if (isAbsolute(arg)) {
    return {
      kind: 'path',
      path: resolve(arg),
    };
  }
  return {
    kind: 'path',
    path: resolve(effectiveCwd, arg),
  };
}

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
 * One-time notice rendered the first time the user runs `cd`, explaining
 * that the agent's own tools still resolve against the launch-time cwd.
 */
export function buildCdSplitNoticeEntry(agentCwd: string): SystemEntry {
  return {
    role: 'system',
    type: 'info',
    content:
      'Note: cd updates the cwd for your local `!` / shortcut commands only. ' +
      `The agent's own tools (read, write, bash, ...) continue to resolve paths ` +
      `against the launch-time cwd: ${agentCwd}`,
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
