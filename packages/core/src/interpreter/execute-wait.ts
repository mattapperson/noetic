/**
 * Runs a `wait` step: listens for a connection event, runs `around` once the
 * server confirms the subscription, then waits for the first event the filter
 * accepts (spec 35 § Steps). Listening starts before `around`, so the event an
 * action causes cannot slip past. A pending ledger entry records the start
 * cursor and the deadline, so a resumed run listens again from where it was
 * (spec 23a § Connection Steps).
 */

import type {
  ConnectionEvent,
  Context,
  EventStream,
  ExecuteStepFn,
  Step,
  StepWait,
  StepWaitOutput,
} from '@noetic-tools/types';
import { frameworkCast, NoeticErrorImpl } from '@noetic-tools/types';
import type { PendingEntry, StepConnection } from './connection-steps';
import {
  evaluateTarget,
  reconcilePending,
  resolveStepConnection,
  signalOf,
} from './connection-steps';
import { isStepList } from './step-walk';

//#region Types

/** Options the interpreter passes in. */
export interface ExecuteWaitOptions {
  /** The step's ledger key, from which its pending entry derives. */
  ledgerKey?: string;
}

/** How listening ended. */
type ListenOutcome =
  | {
      kind: 'matched';
      event: ConnectionEvent;
    }
  | {
      kind: 'ended';
      reason: string;
    };

interface ListenContext<TContext, I> {
  step: StepWait<TContext, I, unknown>;
  input: I;
  ctx: Context<TContext>;
  connection: StepConnection;
  stream: EventStream<ConnectionEvent>;
}

//#endregion

//#region Helpers

function aroundSteps<TContext, I>(
  step: StepWait<TContext, I, unknown>,
): ReadonlyArray<Step<TContext, I, unknown>> {
  if (step.around === undefined) {
    return [];
  }
  if (isStepList(step.around)) {
    return step.around;
  }
  return [
    step.around,
  ];
}

/** Runs `around` in sequence, each step's output the next one's input. */
async function runAround<TContext, I>(
  steps: ReadonlyArray<Step<TContext, I, unknown>>,
  input: I,
  ctx: Context<TContext>,
  executeStep: ExecuteStepFn,
): Promise<unknown> {
  let current: unknown = input;
  for (const child of steps) {
    current = await executeStep(child, frameworkCast<I>(current), ctx);
  }
  return current;
}

/** Consumes the stream until an event the filter accepts arrives, or the stream ends. */
async function listenForMatch<TContext, I>(
  listen: ListenContext<TContext, I>,
): Promise<ListenOutcome> {
  const { step, input, ctx, stream } = listen;
  // The registry's stream emits `connection_event` and `stream_changed` (once each).
  for await (const message of stream) {
    if (message.type === 'gap') {
      continue;
    }
    if (message.type === 'terminated') {
      return {
        kind: 'ended',
        reason: message.reason,
      };
    }
    const event = message.event;
    if (event.type !== step.event) {
      continue;
    }
    if (step.filter && !(await step.filter(event, input, ctx))) {
      continue;
    }
    return {
      kind: 'matched',
      event,
    };
  }
  return {
    kind: 'ended',
    reason: 'the event stream closed',
  };
}

/** Resolves `undefined` once `deadline` passes or `signal` aborts; `clear` cancels the timer. */
function deadlineTimer(
  deadline: number,
  signal: AbortSignal,
): {
  promise: Promise<undefined>;
  clear: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const promise = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
    onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, {
      once: true,
    });
  });
  return {
    promise,
    clear: () => {
      clearTimeout(timer);
      if (onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

function endedError(connection: string, stepId: string, reason: string): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'connection_unavailable',
    connection,
    reason: `the event stream wait '${stepId}' was listening on ended: ${reason}`,
  });
}

function timeoutError<TContext, I>(step: StepWait<TContext, I, unknown>): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'step_failed',
    stepId: step.id,
    cause: new Error(
      `wait '${step.id}' saw no matching '${step.event}' event within ${step.timeoutMs} ms.`,
    ),
    retriesExhausted: true,
  });
}

/** Waits for the listener or the deadline, whichever comes first; `undefined` means the deadline. */
async function awaitOutcome(
  matched: Promise<ListenOutcome>,
  deadline: number,
  signal: AbortSignal,
): Promise<ListenOutcome | undefined> {
  const timer = deadlineTimer(deadline, signal);
  try {
    return await Promise.race([
      matched,
      timer.promise,
    ]);
  } finally {
    timer.clear();
  }
}

/** Records the pending entry once the server confirms the subscription; resolves the deadline. */
async function recordListening<TContext, I>(
  listen: ListenContext<TContext, I>,
  prior: PendingEntry | undefined,
): Promise<number> {
  const { step, connection, stream } = listen;
  const { cursor } = await stream.ready;
  const deadline = prior?.deadline ?? Date.now() + step.timeoutMs;
  await connection.pending?.write({
    stepId: step.id,
    kind: 'wait',
    connection: connection.resolved.name,
    key: prior?.key ?? connection.idempotencyKey,
    identity: connection.resolved.identity(),
    cursor: prior?.cursor ?? cursor,
    deadline,
    ...(connection.resolved.lease
      ? {
          leaseId: connection.resolved.lease.id,
        }
      : {}),
  });
  return deadline;
}

/** Listens, runs `around`, then waits for the outcome and turns it into the step's output. */
async function waitOnStream<TContext, I>(opts: {
  listen: ListenContext<TContext, I>;
  prior: PendingEntry | undefined;
  executeStep: ExecuteStepFn;
  runSignal: AbortSignal;
}): Promise<StepWaitOutput> {
  const { listen, prior, executeStep, runSignal } = opts;
  const { step, input, ctx } = listen;
  const deadline = await recordListening(listen, prior);
  const matched = listenForMatch(listen);
  // A listener that fails while `around` runs is reported after it.
  matched.catch(() => undefined);
  const around =
    step.around === undefined
      ? undefined
      : await runAround(aroundSteps(step), input, ctx, executeStep);
  const outcome = await awaitOutcome(matched, deadline, runSignal);
  const event = matchedEvent(listen, outcome, runSignal);
  await listen.connection.pending?.clear();
  return {
    event,
    ...(step.around === undefined
      ? {}
      : {
          around,
        }),
  };
}

/**
 * The event that ended the wait (the registry already emitted it as `connection_event`).
 *
 * @throws `NoeticErrorImpl` `cancelled`, `step_failed` (timeout) or `connection_unavailable` (stream ended).
 */
function matchedEvent<TContext, I>(
  listen: ListenContext<TContext, I>,
  outcome: ListenOutcome | undefined,
  runSignal: AbortSignal,
): ConnectionEvent {
  const { step, connection } = listen;
  const baseCtx = frameworkCast<Context>(listen.ctx);
  if (runSignal.aborted) {
    throw new NoeticErrorImpl({
      kind: 'cancelled',
      reason: baseCtx.abortReason ?? 'context aborted',
    });
  }
  if (outcome === undefined) {
    throw timeoutError(step);
  }
  if (outcome.kind === 'ended') {
    throw endedError(connection.resolved.name, step.id, outcome.reason);
  }
  return outcome.event;
}

//#endregion

//#region Public API

/**
 * Executes a `wait` step and returns `{ event, around }`.
 *
 * @throws `NoeticConfigError` `CONNECTION_UNKNOWN`, `CONNECTION_UNSATISFIED`, `CONNECTION_NOT_ALLOWED` or `CONNECTION_INVALID` from resolution.
 * @throws `NoeticErrorImpl` `connection_unavailable` when the event stream ends, `connection_resume_refused` on a resume against a replaced connection, `step_failed` when `timeoutMs` passes, `cancelled` when the run is aborted.
 */
export async function executeWait<TContext, I, O>(
  step: StepWait<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  executeStep: ExecuteStepFn,
  options: ExecuteWaitOptions = {},
): Promise<O> {
  const baseCtx = frameworkCast<Context>(ctx);
  const erased = frameworkCast<StepWait<TContext, I, unknown>>(step);
  const target = await evaluateTarget(step.connection, input, ctx, step.id);
  const connection = await resolveStepConnection({
    ctx: baseCtx,
    stepId: step.id,
    target,
    use: {
      event: step.event,
    },
    ledgerKey: options.ledgerKey,
  });
  const runSignal = signalOf(baseCtx);
  const prior = await reconcilePending(connection, runSignal, baseCtx);
  const listening = new AbortController();
  const stopListening = (): void => listening.abort();
  runSignal.addEventListener('abort', stopListening, {
    once: true,
  });
  const stream = connection.resolved.listen({
    event: step.event,
    cursor: prior?.cursor ?? null,
    signal: listening.signal,
  });
  try {
    const output = await waitOnStream({
      listen: {
        step: erased,
        input,
        ctx,
        connection,
        stream,
      },
      prior,
      executeStep,
      runSignal,
    });
    return frameworkCast<O>(output);
  } finally {
    runSignal.removeEventListener('abort', stopListening);
    listening.abort();
    await stream.close().catch(() => undefined);
  }
}

//#endregion
