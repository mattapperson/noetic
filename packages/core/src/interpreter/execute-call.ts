/**
 * Runs a `call` step: one connection operation through the harness registry's
 * gates, waiting on long operations (spec 35 § Steps). A pending ledger entry
 * is written before the call reaches the server, so a resumed run re-sends with
 * the same idempotency key instead of acting twice (spec 23a § Connection Steps).
 */

import type { ConnectionTaskStatus, Context, StepCall } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import type { ConnectionCaller, GatedCallOptions } from '../connections/registry-types';
import type { PendingEntry, StepConnection } from './connection-steps';
import {
  evaluateTarget,
  reconcilePending,
  refuseWitnessAct,
  resolveStepConnection,
  signalOf,
} from './connection-steps';

//#region Types

/** Options the interpreter passes in. */
export interface ExecuteCallOptions {
  /** The step's ledger key, from which its idempotency key and pending entry derive. */
  ledgerKey?: string;
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
  options: ExecuteCallOptions = {},
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
  const signal = signalOf(baseCtx);
  const prior = await reconcilePending(connection, signal, baseCtx);
  const key = prior?.key ?? connection.idempotencyKey;
  const entry = baseEntry({
    connection,
    stepId: step.id,
    key,
    prior,
  });
  await connection.pending?.write(entry);
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
    // The registry emits `connection_task` to this run's stream (the call carries ctx).
    onTask: (status: ConnectionTaskStatus) => {
      if (entry.taskId !== status.taskId) {
        entry.taskId = status.taskId;
        void connection.pending?.write(entry);
      }
    },
  };
  // A previous attempt's long operation is waited on, not started again (spec 35 § Durability).
  const output =
    prior?.taskId && connection.resolved.awaitTask
      ? await connection.resolved.awaitTask(prior.taskId, step.op, callOptions)
      : await connection.resolved.call(step.op, args, callOptions);
  await connection.pending?.clear();
  return frameworkCast<O>(output);
}

//#endregion
