/**
 * Step-child completion handling extracted from the local subprocess
 * adapter factory. On child exit, the factory invokes
 * `handleStepCompletion` with the exit code + captured stdout/stderr.
 * This helper parses the child's JSON envelope and updates the handle
 * state accordingly (completed / failed), also clearing the durable
 * manifest so `listLive()` doesn't return a phantom entry post-exit.
 */

import type { LiveHandles, SerializedError, SubprocessHandle } from '@noetic-tools/core';

//#region Types

interface StepChildOutcome {
  kind: 'ok' | 'error';
  result?: unknown;
  error?: SerializedError;
}

export interface HandleStepCompletionArgs {
  handleId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  live: LiveHandles;
  persisted: Promise<void>;
  clearIfDurable: (handleId: string) => Promise<void>;
}

//#endregion

//#region Output parsing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

function parseStepOutput(raw: string): StepChildOutcome | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  // The bootstrap emits exactly one JSON envelope on stdout. Accept the last
  // line so stray `console.log` emissions upstream don't poison the parse.
  const lastLine = trimmed.split('\n').pop() ?? '';
  try {
    const parsed = parseJson(lastLine);
    if (!isRecord(parsed)) {
      return null;
    }
    if (parsed.kind === 'ok') {
      return {
        kind: 'ok',
        result: parsed.result,
      };
    }
    if (parsed.kind === 'error' && isRecord(parsed.error)) {
      return {
        kind: 'error',
        error: {
          message:
            typeof parsed.error.message === 'string' ? parsed.error.message : 'unknown error',
          name: typeof parsed.error.name === 'string' ? parsed.error.name : undefined,
          stack: typeof parsed.error.stack === 'string' ? parsed.error.stack : undefined,
          noeticError: parsed.error.noeticError,
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

//#endregion

//#region Public API

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Settle a spawned step child into its final handle state. Called
 * from the `child.on('close')` listener in the local adapter's
 * `spawnStepHandle`. Idempotent — a handle that already settled (a
 * stopped child, say) is left alone.
 */
export async function handleStepCompletion(args: HandleStepCompletionArgs): Promise<void> {
  const current = args.live.get(args.handleId);
  if (!current) {
    return;
  }
  args.live.settle({
    ...current,
    updatedAt: nowIso(),
    ...outcomeOf(args, current),
  });
  // The child exited — clear its manifest regardless of how it ended.
  await args.persisted;
  await args.clearIfDurable(args.handleId);
}

function outcomeOf(
  args: HandleStepCompletionArgs,
  current: SubprocessHandle,
): Pick<SubprocessHandle, 'status' | 'metadata'> {
  const outcome = parseStepOutput(args.stdout);
  if (outcome?.kind === 'ok' && args.exitCode === 0) {
    return {
      status: 'completed',
      metadata: {
        ...(current.metadata ?? {}),
        result: outcome.result,
        exitCode: args.exitCode,
      },
    };
  }
  const failureMessage =
    outcome?.kind === 'error' && outcome.error
      ? outcome.error
      : {
          message:
            args.stderr.trim() !== ''
              ? args.stderr.trim()
              : `Local step subprocess exited with code ${args.exitCode ?? 'null'}`,
        };
  return {
    status: 'failed',
    metadata: {
      ...(current.metadata ?? {}),
      error: failureMessage,
      exitCode: args.exitCode,
      stderr: args.stderr.trim() || undefined,
    },
  };
}

//#endregion
