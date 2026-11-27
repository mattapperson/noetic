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
import { ContextImpl } from '../runtime/context-impl';
import { isBeneath } from '../runtime/durable/parking';
import { hashStepInput, REPLAY_KEY_PREFIX } from '../runtime/durable/step-ledger';
import type { PendingEntry, StepConnection } from './connection-steps';
import {
  evaluateTarget,
  reconcilePending,
  resolveStepConnection,
  signalOf,
} from './connection-steps';
import { isStepList, stepChildren } from './step-walk';
import { guardAround } from './wait-around';

//#region Types

/** Options the interpreter passes in. */
export interface ExecuteWaitOptions {
  /** The step's ledger key, from which its pending entry derives. */
  ledgerKey?: string;
  onRecorded?(cleanup: (stored: boolean) => Promise<void>): void;
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

interface WaitContext<TContext, I> {
  step: StepWait<TContext, I, unknown>;
  input: I;
  ctx: Context<TContext>;
  connection: StepConnection;
}

interface ListenContext<TContext, I> extends WaitContext<TContext, I> {
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

function aroundDispatch<TContext, I>(listen: WaitContext<TContext, I>): PendingEntry['around'] {
  const { step, ctx } = listen;
  const steps = aroundSteps(step);
  if (steps.length === 0) {
    return null;
  }
  if (!(ctx instanceof ContextImpl)) {
    return undefined;
  }
  const dispatch = ctx.currentDispatch();
  const shape = hashStepInput(steps.map((child) => stepShape(frameworkCast<Step>(child))));
  return dispatch?.inputHash === undefined || shape === undefined
    ? undefined
    : {
        path: dispatch.path,
        inputHash: dispatch.inputHash,
        shape,
      };
}

function stepShape(step: Step): unknown {
  return [
    step.kind,
    step.id,
    step.execution?.durable ?? step.durable,
    (step.execution?.replayKey ?? step.replayKey) !== undefined,
    stepChildren(step).map(stepShape),
  ];
}

/** A moved or changed wait could run its earlier actions under new ledger keys. */
function sameAround<TContext, I>(listen: WaitContext<TContext, I>, prior: PendingEntry): boolean {
  if (aroundSteps(listen.step).length === 0) {
    return prior.around === null || prior.around === undefined;
  }
  const current = aroundDispatch(listen);
  return (
    current !== undefined &&
    current !== null &&
    current.path === prior.around?.path &&
    current.inputHash === prior.around.inputHash &&
    current.shape === prior.around.shape
  );
}

/** Before the around marker existed, a descendant receipt or intent is evidence of prior work. */
async function checkLegacyAround<TContext, I>(
  listen: WaitContext<TContext, I>,
  prior: PendingEntry,
): Promise<void> {
  const { ctx, connection, step } = listen;
  if (!(ctx instanceof ContextImpl)) {
    return;
  }
  const execution = connection.scope.executionId;
  // A keyed legacy wait may have moved, so its old children can be anywhere in this run.
  const keyed = connection.idempotencyKey.startsWith(`${execution}:${REPLAY_KEY_PREFIX}`);
  const path = keyed ? undefined : ctx.currentPath();
  for (const entry of ctx.ledger?.savedEntries() ?? []) {
    if (
      (path !== undefined && isBeneath(entry.path, path)) ||
      (entry.effect && (keyed || entry.path.startsWith(REPLAY_KEY_PREFIX)))
    ) {
      throw unknownWait(connection, step.event, prior.key);
    }
  }
  if (await connection.pending?.hasLegacyActions(execution, path)) {
    throw unknownWait(connection, step.event, prior.key);
  }
}

/** Runs `around` in sequence, each step's output the next one's input. */
async function runAround<TContext, I>(
  listen: WaitContext<TContext, I>,
  entry: PendingEntry,
  resumed: boolean,
  executeStep: ExecuteStepFn,
): Promise<unknown> {
  const { ctx, input, step, connection } = listen;
  const guard =
    ctx instanceof ContextImpl
      ? guardAround(ctx, () => unknownWait(connection, step.event, entry.key))
      : undefined;
  let current: unknown = input;
  try {
    for (const child of aroundSteps(step)) {
      current = await executeStep(child, frameworkCast<I>(current), ctx);
    }
    if (resumed) {
      await guard?.check();
    }
    return current;
  } finally {
    guard?.stop();
  }
}

function unknownWait(connection: StepConnection, op: string, key: string): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'connection_outcome_unknown',
    connection: connection.resolved.name,
    op,
    key,
  });
}

/**
 * Runs the step's filter on one event. A filter is work, not waiting: while it runs
 * the turn must not park, or a filter slower than the park's grace would be cut off
 * on every wake and its event never delivered.
 */
async function acceptsEvent<TContext, I>(
  { step, input, ctx }: WaitContext<TContext, I>,
  event: ConnectionEvent,
): Promise<boolean> {
  if (event.type !== step.event) {
    return false;
  }
  if (!step.filter) {
    return true;
  }
  const busy = ctx instanceof ContextImpl ? ctx.ledger?.parking.enter(undefined) : undefined;
  try {
    return await step.filter(event, input, ctx);
  } finally {
    busy?.();
  }
}

/** Consumes the stream until an event the filter accepts arrives, or the stream ends. */
async function listenForMatch<TContext, I>(
  listen: ListenContext<TContext, I>,
  rejected: ConnectionEvent | undefined,
  save: (event: ConnectionEvent) => boolean,
): Promise<ListenOutcome> {
  const { stream } = listen;
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
    if (event.id === rejected?.id || !(await acceptsEvent(listen, event))) {
      continue;
    }
    if (!save(event)) {
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

/** The harness clock (`AgentHarness({ now })`), which deadlines are read from. */
function nowOf(ctx: Context): number {
  return ctx.harness.config.now?.() ?? Date.now();
}

/** Resolves `undefined` once `remainingMs` pass or `signal` aborts; `clear` cancels the timer. */
function deadlineTimer(
  remainingMs: number | undefined,
  signal: AbortSignal,
  stop: () => void,
): {
  promise: Promise<undefined>;
  clear: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const promise = new Promise<undefined>((resolve) => {
    onAbort = () => {
      stop();
      resolve(undefined);
    };
    if (remainingMs !== undefined) {
      timer = setTimeout(onAbort, Math.max(0, remainingMs));
    }
    if (signal.aborted) {
      onAbort();
    }
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

/** A saved event can still match after the deadline, but validation must stop on abort. */
async function recheck<TContext, I>(
  listen: WaitContext<TContext, I>,
  event: ConnectionEvent,
  signal: AbortSignal,
): Promise<boolean> {
  const ctx = frameworkCast<Context>(listen.ctx);
  assertRunning(ctx, signal);
  const abort = deadlineTimer(undefined, signal, () => {});
  try {
    const accepted = await Promise.race([
      acceptsEvent(listen, event),
      abort.promise,
    ]);
    assertRunning(ctx, signal);
    return accepted === true;
  } finally {
    abort.clear();
  }
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
async function awaitOutcome({
  matched,
  remainingMs,
  signal,
  stop,
}: {
  matched: Promise<ListenOutcome>;
  remainingMs: number;
  signal: AbortSignal;
  stop: () => void;
}): Promise<ListenOutcome | undefined> {
  const timer = deadlineTimer(remainingMs, signal, stop);
  try {
    return await Promise.race([
      matched,
      timer.promise,
    ]);
  } finally {
    timer.clear();
  }
}

/** Records the pending entry once the server confirms the subscription. */
async function recordListening<TContext, I>(
  listen: ListenContext<TContext, I>,
  prior: PendingEntry | undefined,
): Promise<PendingEntry> {
  const { step, connection, stream } = listen;
  const { cursor } = await stream.ready;
  const deadline = prior?.deadline ?? nowOf(frameworkCast<Context>(listen.ctx)) + step.timeoutMs;
  const entry: PendingEntry = {
    stepId: step.id,
    kind: 'wait',
    connection: connection.resolved.name,
    key: prior?.key ?? connection.idempotencyKey,
    identity: connection.resolved.identity(),
    cursor: prior?.cursor === undefined ? cursor : prior.cursor,
    deadline,
    around: aroundDispatch(listen),
    event: step.event,
    durable: replaysFromCursor(listen),
    ...(connection.resolved.lease
      ? {
          leaseId: connection.resolved.lease.id,
        }
      : {}),
  };
  await connection.pending?.write(entry);
  return entry;
}

/** Listens, runs `around`, then waits for the outcome and turns it into the step's output. */
async function waitOnStream<TContext, I>(opts: {
  listen: ListenContext<TContext, I>;
  prior: PendingEntry | undefined;
  rejected: ConnectionEvent | undefined;
  executeStep: ExecuteStepFn;
  runSignal: AbortSignal;
}): Promise<StepWaitOutput> {
  const { listen, prior, executeStep, runSignal } = opts;
  const { step, ctx } = listen;
  const entry = await recordListening(listen, prior);
  const deadline = entry.deadline ?? nowOf(frameworkCast<Context>(ctx));
  let saved: Promise<void> | undefined;
  let accepting = true;
  const baseCtx = frameworkCast<Context>(ctx);
  const matched = listenForMatch(listen, opts.rejected, (event) => {
    if (!accepting || runSignal.aborted || nowOf(baseCtx) > deadline) {
      return false;
    }
    saved = listen.connection.pending?.write({
      ...entry,
      matched: event,
    });
    void saved?.catch(() => undefined);
    return true;
  });
  // A listener that fails while `around` runs is reported after it.
  matched.catch(() => undefined);
  try {
    const around =
      step.around === undefined
        ? undefined
        : await runAround(listen, entry, prior !== undefined, executeStep);
    const stopWaiting = typeof entry.cursor !== 'string' ? () => {} : markWaiting(listen, deadline);
    try {
      const outcome = await awaitOutcome({
        matched,
        remainingMs: deadline - nowOf(baseCtx),
        signal: runSignal,
        stop: () => {
          accepting = false;
        },
      });
      return {
        event: matchedEvent(listen, outcome, runSignal),
        ...(step.around === undefined
          ? {}
          : {
              around,
            }),
      };
    } finally {
      stopWaiting();
    }
  } finally {
    accepting = false;
    // A cut in `around` must leave any already accepted event for the next owner.
    await saved;
  }
}

/** True when the event this wait listens for replays from a cursor. */
function replaysFromCursor<TContext, I>(listen: WaitContext<TContext, I>): boolean {
  return listen.connection.resolved.manifest.events[listen.step.event]?.replay === 'durable';
}

/**
 * Tells the turn's parking that this step is now only waiting, when the wait can be
 * picked up again without loss: the event replays from a cursor, so a turn that
 * parks here and wakes later still sees an event that arrived in between
 * (spec 23 § Parked turns). Returns what to call when the wait ends.
 */
function markWaiting<TContext, I>(
  listen: ListenContext<TContext, I>,
  deadline: number,
): () => void {
  const { ctx } = listen;
  if (!(ctx instanceof ContextImpl) || !ctx.ledger) {
    return () => {};
  }
  if (!replaysFromCursor(listen)) {
    return () => {};
  }
  // A wait whose time is already up is about to fail, not to wait.
  if (deadline <= nowOf(frameworkCast<Context>(ctx))) {
    return () => {};
  }
  return ctx.ledger.parking.wait(ctx.currentDispatch()?.path, deadline);
}

/**
 * The event that ended the wait (the registry already emitted it as `connection_event`).
 *
 * @throws `NoeticErrorImpl` `cancelled`, `step_failed` (timeout) or `connection_unavailable` (stream ended).
 */
function matchedEvent<TContext, I>(
  listen: WaitContext<TContext, I>,
  outcome: ListenOutcome | undefined,
  runSignal: AbortSignal,
): ConnectionEvent {
  const { step, connection } = listen;
  assertRunning(frameworkCast<Context>(listen.ctx), runSignal);
  if (outcome === undefined) {
    throw timeoutError(step);
  }
  if (outcome.kind === 'ended') {
    throw endedError(connection.resolved.name, step.id, outcome.reason);
  }
  return outcome.event;
}

function assertRunning(ctx: Context, signal: AbortSignal): void {
  if (signal.aborted) {
    throw new NoeticErrorImpl({
      kind: 'cancelled',
      reason: ctx.abortReason ?? 'context aborted',
    });
  }
}

function checkPendingWait<TContext, I>(
  listen: WaitContext<TContext, I>,
  entry: PendingEntry | undefined,
): void | Promise<void> {
  const { connection, step } = listen;
  if (connection.pending?.unreadable) {
    throw unknownWait(connection, step.event, connection.idempotencyKey);
  }
  if (!entry) {
    return;
  }
  if (
    entry.kind !== 'wait' ||
    entry.stepId !== step.id ||
    entry.event !== step.event ||
    entry.connection !== connection.resolved.name ||
    !sameAround(listen, entry) ||
    (entry.durable === false && !entry.matched)
  ) {
    throw unknownWait(connection, step.event, entry.key);
  }
  if (entry.around === undefined) {
    return checkLegacyAround(listen, entry);
  }
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
  const unknown = (entry: PendingEntry) => unknownWait(connection, step.event, entry.key);
  const listen = {
    step: erased,
    input,
    ctx,
    connection,
  };
  const prior = await reconcilePending(connection, runSignal, {
    ctx: baseCtx,
    check: (entry) => checkPendingWait(listen, entry),
  });
  options.onRecorded?.(async (stored) => {
    if (stored) {
      await connection.pending?.clear().catch(() => undefined);
    }
  });
  const cached = prior?.matched;
  if (prior && cached && (await recheck(listen, cached, runSignal))) {
    const around =
      step.around === undefined ? undefined : await runAround(listen, prior, true, executeStep);
    return frameworkCast<O>({
      event: matchedEvent(
        listen,
        {
          kind: 'matched',
          event: cached,
        },
        runSignal,
      ),
      ...(step.around === undefined
        ? {}
        : {
            around,
          }),
    });
  }
  // Without an accepted receipt, a live-only wait cannot account for events
  // it missed during the cut. A durable wait can still use the original cursor.
  if (
    prior &&
    (typeof prior.cursor !== 'string' || prior.durable === false || !replaysFromCursor(listen))
  ) {
    throw unknown(prior);
  }
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
        ...listen,
        stream,
      },
      prior,
      rejected: cached,
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
