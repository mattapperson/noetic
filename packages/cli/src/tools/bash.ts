/**
 * Bash tool — execute bash commands with streaming output.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShellAdapter, Tool } from '@noetic/core';
import { toolWithGenerator } from '@noetic/core';
import { z } from 'zod';
import { validateCommand } from './security.js';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from './truncate.js';

//#region Constants

const DEFAULT_BASH_TIMEOUT = 12e1;

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
 - Maintain your current working directory throughout the session by using absolute paths and avoiding \`cd\`. Use \`cd\` only if the user explicitly requests it.
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

  if (error.message.startsWith('timeout:')) {
    const timeoutSecs = error.message.split(':')[1];
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

//#endregion

//#region Public API

export type BashTool = Tool<typeof BashInputSchema, typeof BashOutputSchema>;

export function createBashTool(cwd: string, shell: ShellAdapter): BashTool {
  return toolWithGenerator({
    name: 'Bash',
    description: BASH_TOOL_DESCRIPTION,
    input: BashInputSchema,
    output: BashOutputSchema,
    event: BashEventSchema,
    async *execute(params) {
      const { command, timeout: userTimeout } = params;
      const timeout = Math.min(userTimeout ?? DEFAULT_BASH_TIMEOUT, 6e2);

      const validation = validateCommand(command);
      if (!validation.valid) {
        return {
          output: `Error: ${validation.error}`,
          command,
          cancelled: false,
          truncated: false,
          timeout,
        };
      }

      let tempFilePath: string | undefined;
      let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
      let totalBytes = 0;
      const chunks: Buffer[] = [];
      let chunksBytes = 0;
      const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

      let resolveData: ((value: Buffer | null) => void) | null = null;
      const dataQueue: (Buffer | null)[] = [];
      const execState: ExecState = {
        result: null,
        error: null,
        done: false,
      };

      const execPromise = shell
        .exec(command, {
          cwd,
          timeout,
          onData: (data: Buffer) => {
            if (resolveData) {
              resolveData(data);
              resolveData = null;
            } else {
              dataQueue.push(data);
            }
          },
        })
        .then((r) => {
          execState.result = {
            exitCode: r.exitCode,
          };
          execState.done = true;
          if (resolveData) {
            resolveData(null);
            resolveData = null;
          } else {
            dataQueue.push(null);
          }
        })
        .catch((err: Error) => {
          execState.error = err;
          execState.done = true;
          if (resolveData) {
            resolveData(null);
            resolveData = null;
          }
        });

      const getNextChunk = (): Promise<Buffer | null> => {
        if (dataQueue.length > 0) {
          return Promise.resolve(dataQueue.shift() ?? null);
        }
        if (execState.done) {
          return Promise.resolve(null);
        }
        return new Promise<Buffer | null>((resolve) => {
          resolveData = resolve;
        });
      };

      while (true) {
        const data = await getNextChunk();
        if (data === null) {
          break;
        }

        totalBytes += data.length;

        if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
          tempFilePath = getTempFilePath();
          tempFileStream = createWriteStream(tempFilePath);
          for (const chunk of chunks) {
            tempFileStream.write(chunk);
          }
        }

        if (tempFileStream) {
          tempFileStream.write(data);
        }

        chunks.push(data);
        chunksBytes += data.length;
        while (chunksBytes > maxChunksBytes && chunks.length > 1) {
          const removed = chunks.shift();
          if (removed) {
            chunksBytes -= removed.length;
          }
        }

        const fullBuffer = Buffer.concat(chunks);
        const partialOutput = truncateTail(fullBuffer.toString('utf-8')).content || '';
        yield {
          type: 'progress' as const,
          partialOutput,
          bytesReceived: totalBytes,
        };
      }

      await execPromise;

      if (tempFileStream) {
        tempFileStream.end();
      }

      const finalExitCode = execState.result ? execState.result.exitCode : null;

      if (execState.error) {
        const errorResult = buildErrorResult({
          command,
          chunks,
          error: execState.error,
          timeout,
        });
        if (errorResult) {
          return errorResult;
        }
        throw execState.error;
      }

      return buildFinalResult({
        command,
        chunks,
        tempFilePath,
        exitCode: finalExitCode,
        timeout,
      });
    },
  });
}

//#endregion
