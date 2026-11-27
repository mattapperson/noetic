/**
 * Runs a `call` step: one connection operation through the harness registry's
 * gates, waiting on long operations (spec 35 § Steps). A pending ledger entry
 * is written before the call reaches the server, so a resumed run re-sends with
 * the same idempotency key instead of acting twice (spec 23a § Connection Steps).
 */

import type { ConnectionOperationInfo, Context, StepCall } from '@noetic-tools/types';
import { frameworkCast, isNoeticError, NoeticErrorImpl } from '@noetic-tools/types';
import { sameInstance } from '../connections/durability';
import type { ConnectionCaller, GatedCallOptions } from '../connections/registry-types';
import { ContextImpl } from '../runtime/context-impl';
import { hashStepInput } from '../runtime/durable/step-ledger';
import type { PendingEntry, StepConnection } from './connection-steps';
import {
  evaluateTarget,
  reconcilePending,
  refuseWitnessAct,
  resolveStepConnection,
  signalOf,
} from './connection-steps';
import { turnEndingIn } from './turn-ending';

//#region Types

/** Options the interpreter passes in. */
export interface ExecuteCallOptions {
  /** The step's ledger key, from which its idempotency key and pending entry derive. */
  ledgerKey?: string;
  onRecorded(cleanup: (stored: boolean) => Promise<void>): void;
}

/** Internal fields a hydrated JSON `call` node carries. */
interface DocumentCallFields {
  /** `'document'` for a JSON node, so the gates treat it as one. */
  _caller?: ConnectionCaller;
  /** Every operation the document uses on this connection (gate 1). */
  _declaredOps?: ReadonlyArray<string>;
  /** The secrets the node's arguments write out (the only ones the gates let it send). */
  _documentSecrets?: ReadonlyArray<{
    name: string;
    field: string;
  }>;
}

//#endregion

//#region Helpers

async function resolveArgs<TContext, I, O>(
  step: StepCall<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
): Promise<unknown> {
  if (typeof step.args === 'function') {
    return await step.args(input, ctx);
  }
  return step.args ?? {};
}

function baseEntry(opts: {
  connection: StepConnection;
  stepId: string;
  key: string;
  prior: PendingEntry | undefined;
}): PendingEntry {
  const { connection, stepId, key, prior } = opts;
  return {
    stepId,
    kind: 'call',
    connection: connection.resolved.name,
    key,
    identity: connection.resolved.identity(),
    ...(prior?.taskId
      ? {
          taskId: prior.taskId,
        }
      : {}),
    ...(connection.resolved.lease
      ? {
          leaseId: connection.resolved.lease.id,
        }
      : {}),
  };
}

//#endregion

//#region Public API

/**
 * Executes a `call` step and returns the operation's output.
 *
 * @throws `NoeticConfigError` `CONNECTION_UNKNOWN`, `CONNECTION_UNSATISFIED`, `CONNECTION_NOT_ALLOWED` or `CONNECTION_INVALID` from resolution.
 * @throws `NoeticErrorImpl` `steering_denied` when a gate refuses, or `connection_failed`, `connection_unavailable`, `connection_ref_invalid`, `connection_secret_refused`, `connection_input_required`, `connection_resume_refused`.
 */
export async function executeCall<TContext, I, O>(
  step: StepCall<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  options: ExecuteCallOptions,
): Promise<O> {
  const baseCtx = frameworkCast<Context>(ctx);
  const target = await evaluateTarget(step.connection, input, ctx, step.id);
  const args = await resolveArgs(step, input, ctx);
  const connection = await resolveStepConnection({
    ctx: baseCtx,
    stepId: step.id,
    target,
    use: {
      op: step.op,
    },
    ledgerKey: options.ledgerKey,
  });
  refuseWitnessAct(baseCtx, connection.resolved, step.op);
  // An operation with a lasting effect marks its step: a turn resumed under another
  // flow version will not throw that record away unasked (spec 23 § Versions).
  const info = connection.resolved.manifest.operations[step.op];
  if ((info?.once || info?.effects) && baseCtx instanceof ContextImpl) {
    baseCtx.ledger?.noteEffect(baseCtx.currentDispatch()?.path);
  }
  const signal = signalOf(baseCtx);
  const argsHash = hashStepInput(args);
  const effect = info?.once === true || info?.effects === true;
  const pending = connection.pending;
  const unknown = (key: string, retry?: 'same-key' | 'task') =>
    new NoeticErrorImpl({
      kind: 'connection_outcome_unknown',
      connection: connection.resolved.name,
      op: step.op,
      key,
      retry,
    });
  const prior = await reconcilePending(connection, signal, {
    ctx: baseCtx,
    check: (saved) => {
      if (pending?.unreadable) {
        throw unknown(connection.idempotencyKey);
      }
      if (
        saved &&
        (effect || saved.effect) &&
        !canResume({
          saved,
          connection,
          op: step.op,
          argsHash,
          info,
        })
      ) {
        throw unknown(saved.key);
      }
    },
  });
  const key = prior?.key ?? connection.idempotencyKey;
  const entry = {
    ...baseEntry({
      connection,
      stepId: step.id,
      key,
      prior,
    }),
    op: step.op,
    argsHash,
    effect,
  };
  let sent = false;
  let knownTask = prior?.taskId;
  options.onRecorded(async (stored) => {
    if (stored) {
      await pending?.clear().catch(() => undefined);
    }
  });
  const document = frameworkCast<DocumentCallFields>(step);
  const callOptions: GatedCallOptions = {
    signal,
    caller: document._caller ?? 'step',
    idempotencyKey: key,
    stepId: step.id,
    declaredOps: document._declaredOps ?? [
      step.op,
    ],
    ...(document._documentSecrets
      ? {
          documentSecrets: document._documentSecrets,
        }
      : {}),
    ctx: baseCtx,
    beforeSend: async () => {
      await pending?.write(entry);
      sent = true;
    },
    onRefused: async () => {
      await pending?.clear();
      sent = false;
    },
    onTaskStarted: async (taskId) => {
      await pending?.write({
        ...entry,
        taskId,
      });
      knownTask = taskId;
      markWaiting();
    },
  };
  // Once the long operation has an id on record the step only waits for it, and a
  // parked turn can come back for it (spec 23 § Parked turns).
  let stopWaiting: (() => void) | undefined;
  const markWaiting = (): void => {
    if (stopWaiting || !(baseCtx instanceof ContextImpl) || !connection.pending) {
      return;
    }
    stopWaiting = baseCtx.ledger?.parking.wait(
      baseCtx.currentDispatch()?.path,
      Number.POSITIVE_INFINITY,
    );
  };
  if (prior?.taskId) {
    markWaiting();
  }
  // A previous attempt's long operation is waited on, not started again (spec 35 § Durability).
  let output: unknown;
  try {
    output =
      prior?.taskId && connection.resolved.awaitTask
        ? await connection.resolved.awaitTask(prior.taskId, step.op, callOptions)
        : await connection.resolved.call(step.op, args, callOptions);
  } catch (error) {
    const retryWrite = pending !== undefined && info?.once === true && argsHash !== undefined;
    throw callFailure({
      error,
      key,
      unknown,
      knowsTask: knownTask !== undefined,
      hasPending: pending !== undefined,
      writeSent: sent && effect,
      retryWrite,
      aborted: signal.aborted,
    });
  } finally {
    stopWaiting?.();
  }
  return frameworkCast<O>(output);
}

function canResume({
  saved,
  connection,
  op,
  argsHash,
  info,
}: {
  saved: PendingEntry;
  connection: StepConnection;
  op: string;
  argsHash: string | undefined;
  info: ConnectionOperationInfo | undefined;
}): boolean {
  const { resolved } = connection;
  if (saved.connection !== resolved.name) {
    return false;
  }
  const identity = resolved.identity();
  const sameTask =
    saved.taskId !== undefined &&
    (saved.op === undefined || saved.op === op) &&
    (saved.argsHash === undefined || saved.argsHash === argsHash) &&
    saved.identity.surface === identity.surface &&
    resolved.awaitTask !== undefined;
  return (
    sameTask ||
    (info?.once === true &&
      saved.op === op &&
      saved.argsHash !== undefined &&
      saved.argsHash === argsHash &&
      sameInstance(saved.identity, identity))
  );
}

function callFailure({
  error,
  key,
  unknown,
  knowsTask,
  hasPending,
  writeSent,
  retryWrite,
  aborted,
}: {
  error: unknown;
  key: string;
  unknown(key: string, retry?: 'same-key' | 'task'): NoeticErrorImpl;
  knowsTask: boolean;
  hasPending: boolean;
  writeSent: boolean;
  retryWrite: boolean;
  aborted: boolean;
}): unknown {
  const failure = isNoeticError(error) ? error.noeticError : undefined;
  const code = failure?.kind === 'connection_failed' ? failure.error.code : undefined;
  if (knowsTask && code === 'not_found') {
    return unknown(key);
  }
  if (aborted || turnEndingIn(error)) {
    return error;
  }
  if (knowsTask) {
    return !failure || code === 'unavailable'
      ? unknown(key, hasPending ? 'task' : undefined)
      : error;
  }
  return writeSent ? unknown(key, retryWrite ? 'same-key' : undefined) : error;
}

//#endregion
