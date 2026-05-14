/**
 * Step-child completion handling extracted from the local subprocess
 * adapter factory. On child exit, the factory invokes
 * `handleStepCompletion` with the exit code + captured stdout/stderr.
 * This helper parses the child's JSON envelope and updates the handle
 * state accordingly (completed / failed), also clearing the durable
 * manifest so `listLive()` doesn't return a phantom entry post-exit.
 */

import type { SerializedError, SubprocessHandle } from '@noetic-tools/core';

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
  handles: Map<string, SubprocessHandle>;
  save: (handle: SubprocessHandle) => Promise<SubprocessHandle>;
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
 * Resolve a spawned step child into a terminal handle state. Called
 * from the `child.on('close')` listener in the local adapter's
 * `spawnStepHandle`. Idempotent — a handle that isn't in `running`
 * status is treated as already-finalised and returns early.
 */
export async function handleStepCompletion(args: HandleStepCompletionArgs): Promise<void> {
  const current = args.handles.get(args.handleId);
  if (!current || current.status !== 'running') {
    return;
  }
  // The child exited — clear its manifest regardless of terminal state.
  await args.clearIfDurable(args.handleId);
  const outcome = parseStepOutput(args.stdout);
  if (outcome?.kind === 'ok' && args.exitCode === 0) {
    await args.save({
      ...current,
      status: 'completed',
      updatedAt: nowIso(),
      metadata: {
        ...(current.metadata ?? {}),
        result: outcome.result,
        exitCode: args.exitCode,
      },
    });
    return;
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
  await args.save({
    ...current,
    status: 'failed',
    updatedAt: nowIso(),
    metadata: {
      ...(current.metadata ?? {}),
      error: failureMessage,
      exitCode: args.exitCode,
      stderr: args.stderr.trim() || undefined,
    },
  });
}

//#endregion
