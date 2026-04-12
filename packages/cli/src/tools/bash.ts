/**
 * Bash tool — execute bash commands with streaming output.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@noetic/core';
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

export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
    },
  ) => Promise<{
    exitCode: number | null;
  }>;
}

interface ExecState {
  result: {
    exitCode: number | null;
  } | null;
  error: Error | null;
  done: boolean;
}

//#endregion

//#region Default Operations

const defaultBashOperations: BashOperations = {
  exec: async (command, cwd, { onData, timeout }) => {
    const proc = Bun.spawn(
      [
        'sh',
        '-c',
        command,
      ],
      {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    if (timeout !== undefined && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        proc.kill();
      }, timeout * 1e3);
    }

    try {
      const [stdoutText, stderrText] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const combined = stdoutText + stderrText;
      if (combined) {
        onData(Buffer.from(combined));
      }

      const exitCode = await proc.exited;
      return {
        exitCode,
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  },
};

//#endregion

//#region Tool Description

const BASH_TOOL_DESCRIPTION = `Execute bash commands in the shell.

Usage notes:
- ALWAYS quote file paths containing spaces with double quotes
- NEVER use interactive flags (-i) like 'git rebase -i' or 'git add -i'
- Prefer dedicated tools over bash: read (not cat), write (not echo >), edit (not sed), grep (not grep/rg)
- Output truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. If truncated, full output saved to temp file.

Parameters:
- command: The bash command to execute
- timeout: Timeout in seconds (default: ${DEFAULT_BASH_TIMEOUT}s, max: 600s)

When NOT to use:
- File reading: Use the read tool instead of cat/head/tail
- File writing: Use the write tool instead of echo/cat heredoc
- File editing: Use the edit tool instead of sed/awk
- Code search: Use the grep tool instead of grep/rg
- File search: Use the find tool instead of find command
- Directory listing: Use the ls tool instead of ls command`;

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

export interface BashToolOptions {
  operations?: BashOperations;
}

export type BashTool = Tool<typeof BashInputSchema, typeof BashOutputSchema>;

export function createBashTool(cwd: string, options?: BashToolOptions): BashTool {
  const ops = options?.operations ?? defaultBashOperations;

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

      const execPromise = ops
        .exec(command, cwd, {
          onData: (data: Buffer) => {
            if (resolveData) {
              resolveData(data);
              resolveData = null;
            } else {
              dataQueue.push(data);
            }
          },
          timeout,
        })
        .then((r) => {
          execState.result = r;
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
