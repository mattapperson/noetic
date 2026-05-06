/**
 * Bash tool — execute bash commands with streaming output.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShellAdapter, Tool, ToolExecutionContext } from '@noetic/core';
import { getToolCwd, setToolCwd, TIMEOUT_ERROR_PREFIX, toolWithGenerator } from '@noetic/core';
import { z } from 'zod';
import { handleCd, isPlainCdCommand, parseCdArg } from './cd-helper.js';
import type { MutationPolicy } from './mutation-policy.js';
import { isProbablyMutatingShellCommand } from './mutation-policy.js';
import { validateCommand } from './security.js';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from './truncate.js';

//#region Constants

const DEFAULT_BASH_TIMEOUT = 12e1;

/** Marker prepended to in-process `cd` interceptor output so the model can
 *  distinguish a non-shell cwd update from a normal command's stdout. */
const CD_INTERCEPT_PREFIX = '(cd)';

/**
 * Pre-encoded byte sequences a TUI emits when entering alternate-screen
 * mode. If we see any of these in the output stream the command is taking
 * over the terminal and will hang on input — abort and surface a clear
 * error to the model. Scanned with `Buffer.indexOf` to avoid decoding the
 * full chunk to UTF-8 on every callback.
 *
 * - 1049: xterm alt-screen + cursor save (vim, htop, less, …)
 * - 1047: alt-screen only
 * - 47:   legacy alt-screen
 */
const ESC = String.fromCharCode(27);
const ALT_SCREEN_NEEDLES: ReadonlyArray<Buffer> = [
  Buffer.from(`${ESC}[?1049h`, 'ascii'),
  Buffer.from(`${ESC}[?1047h`, 'ascii'),
  Buffer.from(`${ESC}[?47h`, 'ascii'),
];

function containsAltScreenEntry(data: Buffer): boolean {
  for (const needle of ALT_SCREEN_NEEDLES) {
    if (data.indexOf(needle) !== -1) {
      return true;
    }
  }
  return false;
}

//#endregion

//#region Schemas

const BashInputSchema = z.object({
  command: z.string().describe('Bash command to execute'),
  timeout: z
    .number()
    .optional()
    .describe(`Timeout in seconds (default: ${DEFAULT_BASH_TIMEOUT}s, max: 600s)`),
});

export const BashOutputSchema = z.object({
  output: z.string().describe('Command output (stdout + stderr)'),
  command: z.string().describe('The command that was executed'),
  exitCode: z.number().optional().describe('Exit code (undefined if killed)'),
  cancelled: z.boolean().describe('Whether the command was cancelled'),
  truncated: z.boolean().describe('Whether output was truncated'),
  fullOutputPath: z.string().optional().describe('Path to full output if truncated'),
  timeout: z.number().describe('Timeout value used in seconds'),
});

export const BashEventSchema = z.object({
  type: z.literal('progress'),
  partialOutput: z.string().describe('Partial output received so far'),
  bytesReceived: z.number().describe('Total bytes received'),
});

export type BashOutput = z.infer<typeof BashOutputSchema>;
export type BashEvent = z.infer<typeof BashEventSchema>;

//#endregion

//#region Types

interface ExecState {
  result: {
    exitCode: number | null;
  } | null;
  error: Error | null;
  done: boolean;
}

//#endregion

//#region Tool Description

const BASH_TOOL_DESCRIPTION = `Execute a bash command and return its output.

The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).

IMPORTANT: Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Use the dedicated tool instead:
 - File search: Use Find (NOT find or ls)
 - Content search: Use Grep (NOT grep or rg)
 - Read files: Use Read (NOT cat/head/tail)
 - Edit files: Use Edit (NOT sed/awk)
 - Write files: Use Write (NOT echo >/cat <<EOF)
 - Communication: Output text directly (NOT echo/printf)

# Instructions
 - Before creating new directories or files, run \`ls\` first to verify the parent exists.
 - Always quote file paths with spaces using double quotes (e.g., cd "path with spaces/file.txt").
 - Plain \`cd <path>\` is intercepted in-process and persists for the rest of the session — subsequent Bash, Read, Write, etc. calls resolve relative paths from the new cwd. Compound forms like \`cd foo && ls\` run in a transient shell and do NOT persist cwd; use a dedicated \`cd\` call instead when you want the change to stick.
 - Default timeout: ${DEFAULT_BASH_TIMEOUT}s. Max: 600s. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; if truncated, the full output is saved to a temp file whose path is returned.

# Issuing multiple commands
 - Independent commands that can run in parallel: make multiple Bash calls in a single message.
 - Commands that depend on each other: use a single Bash call with '&&'.
 - Use ';' only when ordering matters but earlier failures are acceptable.
 - Do NOT use newlines to separate commands (newlines are OK inside quoted strings).

# Git safety protocol
 - NEVER update the git config.
 - NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests them. Destructive actions can result in lost work — only run them when given direct instructions.
 - NEVER skip hooks (--no-verify, --no-gpg-sign) unless the user explicitly requests it. If a hook fails, investigate and fix the underlying issue.
 - NEVER force-push to main/master. Warn the user if they request it.
 - CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests an amend. When a pre-commit hook fails the commit did NOT happen — so --amend would modify the PREVIOUS commit, which may destroy work.
 - Prefer adding specific files by name over \`git add -A\` / \`git add .\`, which can accidentally include secrets (.env, credentials) or large binaries.
 - NEVER commit changes unless the user explicitly asks you to.
 - Never use \`-i\` flags (git rebase -i, git add -i) — they require interactive input that is not supported.
 - Never use \`--no-edit\` with \`git rebase\` — it is not a valid rebase option.
 - Always pass commit messages via HEREDOC to preserve formatting.

# Committing (only when the user explicitly asks)
 1. In parallel: \`git status\` (never with -uall — can cause memory issues on large repos), \`git diff\`, and \`git log\` to match the repo's commit-message style.
 2. Draft a concise 1-2 sentence message focused on *why*, not *what* — the diff already shows what changed.
 3. In parallel: stage specific files by name, run the commit using a HEREDOC-passed message, then run \`git status\` to verify success.
 4. If the commit fails due to a pre-commit hook: fix the issue, re-stage, and create a NEW commit — never amend.

# Sleep hygiene
 - Do not sleep between commands that can run immediately.
 - For long-running commands, run the command synchronously if it's under 2 minutes, or ask the user how to proceed for longer jobs.
 - Never retry failing commands in a sleep loop — diagnose the root cause.`;

//#endregion

//#region Helpers

function getTempFilePath(): string {
  const id = randomBytes(8).toString('hex');
  return join(tmpdir(), `noetic-bash-${id}.log`);
}

interface BuildFinalResultParams {
  command: string;
  chunks: Buffer[];
  tempFilePath: string | undefined;
  exitCode: number | null | undefined;
  timeout: number;
}

function buildFinalResult(params: BuildFinalResultParams): BashOutput {
  const { command, chunks, tempFilePath, exitCode, timeout } = params;
  const fullBuffer = Buffer.concat(chunks);
  const fullOutput = fullBuffer.toString('utf-8');
  const truncation = truncateTail(fullOutput);
  let output = truncation.content || '(no output)';
  const truncated = truncation.truncated;

  if (truncated && tempFilePath) {
    const startLine = truncation.totalLines - truncation.outputLines + 1;
    const endLine = truncation.totalLines;

    if (truncation.lastLinePartial) {
      const lastLineSize = formatSize(
        Buffer.byteLength(fullOutput.split('\n').pop() || '', 'utf-8'),
      );
      output += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
    } else if (truncation.truncatedBy === 'lines') {
      output += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
    } else {
      output += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
    }
  }

  if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
    output += `\n\nCommand exited with code ${exitCode}`;
  }

  return {
    output,
    command,
    exitCode: exitCode ?? undefined,
    cancelled: false,
    truncated,
    fullOutputPath: tempFilePath,
    timeout,
  };
}

interface BuildErrorResultParams {
  command: string;
  chunks: Buffer[];
  error: Error;
  timeout: number;
}

function buildErrorResult(params: BuildErrorResultParams): BashOutput | null {
  const { command, error, timeout } = params;
  const fullBuffer = Buffer.concat(params.chunks);
  const output = fullBuffer.toString('utf-8');

  if (error.message === 'aborted') {
    return {
      output: output ? `${output}\n\nCommand aborted` : 'Command aborted',
      command,
      cancelled: true,
      truncated: false,
      timeout,
    };
  }

  if (error.message.startsWith(TIMEOUT_ERROR_PREFIX)) {
    const timeoutSecs = error.message.slice(TIMEOUT_ERROR_PREFIX.length);
    return {
      output: output
        ? `${output}\n\nCommand timed out after ${timeoutSecs} seconds`
        : `Command timed out after ${timeoutSecs} seconds`,
      command,
      cancelled: false,
      truncated: false,
      timeout,
    };
  }

  return null;
}


interface CdInterceptParams {
  command: string;
  timeout: number;
  liveCwd: string;
  toolCtx: ToolExecutionContext;
}

function handleCdIntercept(params: CdInterceptParams): BashOutput | null {
  const { command, timeout, liveCwd, toolCtx } = params;
  if (!isPlainCdCommand(command) || !toolCtx.ctx?.cwdState) {
    return null;
  }
  const cd = handleCd({
    arg: parseCdArg(command),
    effectiveCwd: liveCwd,
    prevCwd: toolCtx.ctx.cwdState.previousCwd ?? null,
  });
  if (cd.kind === 'error') {
    return {
      output: `Error: ${cd.message}`,
      command,
      exitCode: 1,
      cancelled: false,
      truncated: false,
      timeout,
    };
  }
  setToolCwd(toolCtx.ctx, cd.newCwd);
  return {
    output: `${CD_INTERCEPT_PREFIX} cwd is now ${cd.newCwd}`,
    command,
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timeout,
  };
}

async function enforceBashPreflight(args: {
  command: string;
  timeout: number;
  liveCwd: string;
  mutationPolicy?: MutationPolicy;
}): Promise<BashOutput | null> {
  const validation = validateCommand(args.command);
  if (!validation.valid) {
    return {
      output: `Error: ${validation.error}`,
      command: args.command,
      cancelled: false,
      truncated: false,
      timeout: args.timeout,
    };
  }
  const decision = isProbablyMutatingShellCommand(args.command)
    ? await args.mutationPolicy?.check({
        kind: 'bash',
        cwd: args.liveCwd,
        command: args.command,
      })
    : undefined;
  if (!decision || decision.allowed) {
    return null;
  }
  return {
    output: `Error: ${decision.message}`,
    command: args.command,
    cancelled: false,
    truncated: false,
    timeout: args.timeout,
  };
}

interface BashExecutionBuffers {
  tempFilePath?: string;
  tempFileStream?: ReturnType<typeof createWriteStream>;
  totalBytes: number;
  chunks: Buffer[];
  chunksBytes: number;
  maxChunksBytes: number;
}

function createBashExecutionBuffers(): BashExecutionBuffers {
  return {
    totalBytes: 0,
    chunks: [],
    chunksBytes: 0,
    maxChunksBytes: DEFAULT_MAX_BYTES * 2,
  };
}

function appendOutputChunk(buffers: BashExecutionBuffers, data: Buffer): void {
  buffers.totalBytes += data.length;
  if (buffers.totalBytes > DEFAULT_MAX_BYTES && !buffers.tempFilePath) {
    buffers.tempFilePath = getTempFilePath();
    buffers.tempFileStream = createWriteStream(buffers.tempFilePath);
    for (const chunk of buffers.chunks) {
      buffers.tempFileStream.write(chunk);
    }
  }
  buffers.tempFileStream?.write(data);
  buffers.chunks.push(data);
  buffers.chunksBytes += data.length;
  while (buffers.chunksBytes > buffers.maxChunksBytes && buffers.chunks.length > 1) {
    const removed = buffers.chunks.shift();
    if (removed) {
      buffers.chunksBytes -= removed.length;
    }
  }
}

function buildProgressEvent(buffers: BashExecutionBuffers): BashEvent {
  const fullBuffer = Buffer.concat(buffers.chunks);
  return {
    type: 'progress',
    partialOutput: truncateTail(fullBuffer.toString('utf-8')).content || '',
    bytesReceived: buffers.totalBytes,
  };
}

interface DataQueueState {
  resolveData: ((value: Buffer | null) => void) | null;
  dataQueue: (Buffer | null)[];
  execState: ExecState;
}

function createDataQueueState(): DataQueueState {
  return {
    resolveData: null,
    dataQueue: [],
    execState: {
      result: null,
      error: null,
      done: false,
    },
  };
}

function pushData(queue: DataQueueState, data: Buffer | null): void {
  if (queue.resolveData) {
    queue.resolveData(data);
    queue.resolveData = null;
  } else {
    queue.dataQueue.push(data);
  }
}

function nextDataChunk(queue: DataQueueState): Promise<Buffer | null> {
  if (queue.dataQueue.length > 0) {
    return Promise.resolve(queue.dataQueue.shift() ?? null);
  }
  if (queue.execState.done) {
    return Promise.resolve(null);
  }
  return new Promise<Buffer | null>((resolve) => {
    queue.resolveData = resolve;
  });
}

function interactiveTuiResult(command: string, timeout: number): BashOutput {
  return {
    output:
      "Command appears to be an interactive TUI program (it tried to enter alternate-screen mode). Interactive programs aren't supported through this tool — use Read/Edit for files, or invoke the program with non-interactive flags (e.g. `git --no-pager`, `<repl> -c '<expr>'`).",
    command,
    cancelled: true,
    truncated: false,
    timeout,
  };
}

interface ExecuteBashCommandArgs {
  command: string;
  timeout: number;
  liveCwd: string;
  shell: ShellAdapter;
}

async function* executeBashCommand(args: ExecuteBashCommandArgs): AsyncGenerator<BashEvent, BashOutput> {
  const { command, timeout, liveCwd, shell } = args;
  const buffers = createBashExecutionBuffers();
  const queue = createDataQueueState();
  const abortController = new AbortController();
  const execPromise = shell
    .exec(command, {
      cwd: liveCwd,
      timeout,
      signal: abortController.signal,
      onData: (data: Buffer) => {
        if (abortController.signal.aborted) {
          return;
        }
        if (containsAltScreenEntry(data)) {
          abortController.abort();
          return;
        }
        pushData(queue, data);
      },
    })
    .then((r) => {
      queue.execState.result = {
        exitCode: r.exitCode,
      };
      queue.execState.done = true;
      pushData(queue, null);
    })
    .catch((err: Error) => {
      queue.execState.error = err;
      queue.execState.done = true;
      pushData(queue, null);
    });

  while (!abortController.signal.aborted) {
    const data = await nextDataChunk(queue);
    if (data === null) {
      break;
    }
    appendOutputChunk(buffers, data);
    yield buildProgressEvent(buffers);
  }

  await execPromise;
  buffers.tempFileStream?.end();
  if (abortController.signal.aborted) {
    return interactiveTuiResult(command, timeout);
  }
  if (queue.execState.error) {
    const errorResult = buildErrorResult({
      command,
      chunks: buffers.chunks,
      error: queue.execState.error,
      timeout,
    });
    if (errorResult) {
      return errorResult;
    }
    throw queue.execState.error;
  }
  return buildFinalResult({
    command,
    chunks: buffers.chunks,
    tempFilePath: buffers.tempFilePath,
    exitCode: queue.execState.result ? queue.execState.result.exitCode : null,
    timeout,
  });
}

//#endregion

//#region Public API

export type BashTool = Tool<typeof BashInputSchema, typeof BashOutputSchema>;

export function createBashTool(
  cwd: string,
  shell: ShellAdapter,
  mutationPolicy?: MutationPolicy,
): BashTool {
  return toolWithGenerator({
    name: 'Bash',
    description: BASH_TOOL_DESCRIPTION,
    input: BashInputSchema,
    output: BashOutputSchema,
    event: BashEventSchema,
    async *execute(params, toolCtx) {
      const { command, timeout: userTimeout } = params;
      const timeout = Math.min(userTimeout ?? DEFAULT_BASH_TIMEOUT, 6e2);
      const liveCwd = getToolCwd(toolCtx.ctx, cwd);
      const cdResult = handleCdIntercept({
        command,
        timeout,
        liveCwd,
        toolCtx,
      });
      if (cdResult) {
        return cdResult;
      }
      const preflight = await enforceBashPreflight({
        command,
        timeout,
        liveCwd,
        mutationPolicy,
      });
      if (preflight) {
        return preflight;
      }
      return yield* executeBashCommand({
        command,
        timeout,
        liveCwd,
        shell,
      });
    },
  });
}

//#endregion
