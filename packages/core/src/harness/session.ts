import { frameworkCast, isNoeticError, NoeticConfigError } from '@noetic-tools/types';
import { turnEndingIn } from '../interpreter/turn-ending';
import { emitFrameworkEvent } from '../runtime/broadcaster-utils';
import type { HeldCalls } from '../runtime/held-calls';
import { toHeldCall } from '../runtime/held-calls';
import { SessionRunner } from '../runtime/session-runner';
import type { ConnectionGate } from './connection-gate';
import type { QueuedMessage, SessionCtxExtension, TurnLeaseOptions } from './deps/runtime';
import {
  ContextImpl,
  heldElsewhereUntil,
  INTERRUPT_REASON,
  isSteer,
  PARK_REASON,
  rootIdOf,
  TurnLease,
} from './deps/runtime';
import type {
  Context,
  ContextData,
  ExecuteOptions,
  FlowRebuildFailure,
  Item,
  KeptSteers,
  Step,
  Tool,
  TurnCut,
} from './deps/types';
import { savedItemIds } from './model-rounds';
import type { ParkWatchers } from './park-watchers';
import { steerInConversation, steerItems } from './steer-inbox';
import type { StoredFlows, TurnFlow } from './stored-flows';
import { isRebuildFailure } from './stored-flows';
import type { StoredTurnRecord, ThreadRecord } from './thread-record';
import type { TurnCuts } from './turn-cuts';

//#region Session types and queue

export interface Session {
  /** The delivery in progress on this thread, which the next one waits behind. */
  delivering?: Promise<void>;
  readonly runner: SessionRunner;
  /** The thread's history between turns. Used only when durability is off. */
  accumulatedItems: Item[];
  /** The thread's stored session, when durability is on — then the only record. */
  readonly record?: ThreadRecord;
  /** The lease the turn in flight runs under, when storage can compare-and-set. */
  lease?: TurnLease;
  /** Deliveries handed to the session that have not reached its queue yet. */
  arriving?: number;
  /** The `execute()` options of the turn in flight, to resume it with if it parks. */
  turnOptions?: ExecuteOptions;
  /** The flow the turn in flight runs: the harness's, or the stored one it began under. */
  turnGraph?: Step<ContextData, string, string>;
  /** The message ids of the turn in flight: what its cuts are counted by. */
  turnMessageIds?: ReadonlyArray<string>;
  /**
   * The options of messages kept in storage for after a parked turn, by message
   * id. Options hold live objects (layers, connections) storage cannot, so they
   * wait here; a message another process picks up keeps its `resourceId` only.
   */
  readonly keptOptions: Map<string, ExecuteOptions>;
}

/** Keep `message` in storage for after the thread's parked turn, with its options. */
export function keepForLater(
  session: Session,
  record: ThreadRecord,
  message: QueuedMessage,
): Promise<void> {
  session.keptOptions.set(message.id, message.options);
  return record.keepQueued(message);
}

/** Keep queued messages with a paused turn. An interrupt still starts a replacement. */
async function keepQueuedMessages(session: Session, record: ThreadRecord): Promise<void> {
  const interrupts: QueuedMessage[] = [];
  for (const queued of session.runner.queue.drainAll()) {
    if (queued.deliveryMode === 'interrupt') {
      interrupts.push(queued);
      continue;
    }
    await keepForLater(session, record, queued);
  }
  // An interrupt replaces the turn, parked or not: it stays for the runner to start.
  for (const interrupt of interrupts.reverse()) {
    session.runner.queue.prepend(interrupt);
  }
}

/** Where a turn's tools come from, besides the harness's own. */
export interface TurnTools {
  /** The flow the turn runs: its steps' tools are offered. */
  readonly graph: Step | undefined;
  /** The turn's own (`ExecuteOptions.tools`). */
  readonly turn: ReadonlyArray<Tool>;
  /** Those of the connections the turn attached. */
  readonly connections: ReadonlyArray<Tool>;
}

interface SessionHost {
  agentName: string;
  graph: Step<ContextData, string, string> | undefined;
  flows: StoredFlows;
  connections: ConnectionGate;
  createContext(opts: {
    threadId: string;
    items: Item[];
    resourceId?: string;
    state?: unknown;
    contextLayers?: ExecuteOptions['contextLayers'];
    extraContextLayers?: ExecuteOptions['extraContextLayers'];
    _connectionViews: ReturnType<ConnectionGate['turnViews']>['layers'];
    _broadcaster: SessionRunner['broadcaster'];
  }): Context;
  start(): Promise<void>;
  run(graph: Step<ContextData, string, string>, ctx: Context): Promise<string>;
  setTurnTools(ctx: Context, tools: TurnTools): void;
  leaseOptions: TurnLeaseOptions | undefined;
  parkGraceMs: number | undefined;
  parkWatchers: ParkWatchers | undefined;
  cuts: TurnCuts | undefined;
  cutOfContext: WeakMap<Context, TurnCut>;
  holds: HeldCalls;
  announceWakeTime(): Promise<void>;
  announceWakeTimeQuietly(): Promise<void>;
  wakeIfAnswered(threadId: string, executionId: string): Promise<void>;
  wake(opts: { threadId: string; options?: ExecuteOptions }): Promise<string[]>;
  now(): number;
}

//#endregion

//#region Session wiring

export function createSession(
  host: SessionHost,
  threadId: string,
  record: ThreadRecord | undefined,
): Session {
  const session: Session = {
    accumulatedItems: [],
    keptOptions: new Map(),
    record,
    runner: new SessionRunner({
      threadId,
      agentName: host.agentName,
      // The first queued message in a batch establishes `resourceId` /
      // `state` / `context` for the turn. If multiple messages are drained
      // together (queue flush), later messages' values for these fields
      // are ignored. `deliveryMode` is resolved per-message at enqueue
      // time and doesn't apply here.
      createContext: async (items, _turnId, messages) => {
        // One harness drives a thread's turn: take its lease before reading anything.
        const lease =
          record && host.leaseOptions
            ? await TurnLease.take(host.leaseOptions, threadId, {
                // Aborting the thread ends the wait for a lease held elsewhere.
                signal: session.runner.signal,
                // A lease record that was deleted must not start again below the
                // term the thread's own record was last written at.
                above: await record.term(),
              })
            : undefined;
        record?.hold(lease);
        session.lease = lease;
        try {
          if (
            record &&
            (await setAside({
              host,
              session,
              record,
              messages,
            }))
          ) {
            await releaseLease(session);
            return undefined;
          }
          return await buildTurnContext({
            host,
            session,
            items,
            messages,
            lease,
          });
        } catch (error) {
          await releaseLease(session);
          throw error;
        }
      },
      runTurn: async (ctx, _turn, signal) => {
        try {
          return await runTurn({
            host,
            session,
            ctx,
            signal,
          });
        } finally {
          await releaseLease(session);
          // An answer that landed while this harness still held the lease could not
          // wake the turn. Now that it is free, do that.
          if (parkedUntil(ctx) !== undefined) {
            void host.wakeIfAnswered(threadId, ctx.id);
          }
        }
      },
      cutOf: (ctx) => host.cutOfContext.get(ctx),
      heldCalls: async (ctx) =>
        (await host.holds.list(rootIdOf(ctx)))
          .filter((held) => held.resolution === undefined)
          .map(toHeldCall),
      // Stored totals are the session's usage; the runner only mirrors them.
      onTurnUsage: record
        ? async (spent) => {
            session.runner.seedUsage(await record.addUsage(spent));
          }
        : undefined,
    }),
  };

  return session;
}
//#endregion

//#region Turn lifecycle

/** Keep the answer and conversation for redelivery and the next turn. */
async function keepHistory({
  host,
  session,
  ctx,
  answer,
}: {
  host: SessionHost;
  session: Session;
  ctx: Context;
  answer?: string;
}): Promise<void> {
  const { record } = session;
  const { threadId } = session.runner;
  if (record) {
    // A finished turn's answer is kept, so its messages delivered again get it back.
    if (answer !== undefined) {
      await record.answered(ctx, answer);
    }
    await record.end(
      ctx,
      ctx.itemLog.items,
      session.runner.queue.peekAll().map((message) => message.id),
    );
    host.cuts?.forget(threadId);
    return;
  }
  session.accumulatedItems = [
    ...ctx.itemLog.items,
  ];
}

async function buildTurnContext({
  host,
  session,
  items,
  messages,
  lease,
}: {
  host: SessionHost;
  session: Session;
  items: ReadonlyArray<Item>;
  messages: ReadonlyArray<QueuedMessage>;
  lease: TurnLease | undefined;
}): Promise<Context> {
  const { record } = session;
  const { threadId } = session.runner;
  const perTurnOptions: ExecuteOptions = messages[0]?.options ?? {};
  // The turn is starting or resuming here: nothing needs to watch over it.
  session.turnOptions = perTurnOptions;
  host.parkWatchers?.stop(threadId);
  const messageIds = messages.map((m) => m.id);
  session.turnMessageIds = messageIds;
  const history = record ? await record.history() : session.accumulatedItems;
  const flow = await turnFlow({
    host,
    session,
    messageIds,
  });
  session.turnGraph = frameworkCast<Step<ContextData, string, string> | undefined>(flow.graph);
  const { graph } = flow;
  const views = host.connections.turnViews(perTurnOptions.connections, graph);
  // A re-delivery of a cut-off turn's messages picks that turn up where it died.
  const resumed = await record?.resume(messageIds, {
    state: perTurnOptions.state,
    contextLayers: perTurnOptions.contextLayers,
    _broadcaster: session.runner.broadcaster,
  });
  const ctx =
    resumed ??
    host.createContext({
      items: [
        ...history,
        ...items,
      ],
      threadId,
      resourceId: perTurnOptions.resourceId,
      state: perTurnOptions.state,
      contextLayers: perTurnOptions.contextLayers,
      extraContextLayers: perTurnOptions.extraContextLayers,
      _connectionViews: views.layers,
      _broadcaster: session.runner.broadcaster,
    });
  // A context is made to record under the harness's version. This turn's flow is older.
  if (flow.version !== host.flows.own.version && ctx instanceof ContextImpl) {
    ctx.ledger?.runAs(flow.version);
  }
  bindLease(ctx, lease, host.parkGraceMs);
  // A resumed context was made without the turn's view layers.
  if (!resumed) {
    views.bind(ctx);
  }
  frameworkCast<Context & SessionCtxExtension>(ctx)._sessionQueue = session.runner.queue;
  await host.start();
  const connectionTools = await host.connections.openTurn(ctx, perTurnOptions.connections, graph);
  host.setTurnTools(ctx, {
    graph,
    turn: perTurnOptions.tools ?? [],
    connections: connectionTools,
  });
  // A stuck turn the host chose to go on with may discard what no longer matches.
  const accept = (await record?.turn())?.accept;
  if (accept && ctx instanceof ContextImpl) {
    ctx.ledger?.acceptVersionLoss(typeof accept === 'string' ? accept : undefined);
  }
  if (record) {
    await beginStoredTurn({
      host,
      session,
      record,
      ctx,
      messageIds,
      flow,
      keptSteers: perTurnOptions.keptSteers,
    });
  }
  // A turn on record can be cut off from here on. A host that sleeps between
  // requests has to know when to come back and look (see `turnDueAt`).
  if (record && host.leaseOptions) {
    await host.announceWakeTimeQuietly();
  }
  return ctx;
}

/** The flow a turn begins on. */
interface BegunFlow extends TurnFlow {
  /** Set when the turn stored the flow it began under and it could not be rebuilt. */
  readonly failure?: FlowRebuildFailure;
}

/**
 * Keep the source of `flow` under the turn's execution (spec 23 § Stored flows),
 * unless the turn's record says it is there. A turn that moved to a flow with no
 * source, or runs under a new execution, leaves none behind. Resolves the hash of
 * what is stored for the turn.
 */
async function storeTurnFlow({
  host,
  record,
  ctx,
  flow,
}: {
  host: SessionHost;
  record: ThreadRecord;
  ctx: Context;
  flow: BegunFlow;
}): Promise<string | undefined> {
  const prior = await record.turn();
  const held = prior?.executionId === ctx.id ? prior : undefined;
  if (prior?.flow !== undefined && !held) {
    await host.flows.drop(prior.executionId);
  }
  const { stored } = flow;
  if (!stored) {
    if (held?.flow !== undefined) {
      await host.flows.drop(ctx.id);
    }
    return undefined;
  }
  if (held?.flow === stored.hash && held.version === stored.version) {
    return stored.hash;
  }
  return (await host.flows.keep(ctx.id, stored)) ? stored.hash : undefined;
}

/**
 * The flow the turn `messageIds` deliver runs (spec 23 § Versions). A new turn
 * runs the harness's. A turn on record that began under another version runs the
 * flow it stored, rebuilt here; when it stored none, or it cannot be rebuilt, the
 * turn moves to the harness's flow, and a failed rebuild is told as
 * `flow_rebuild_failed`.
 */
async function turnFlow({
  host,
  session,
  messageIds,
}: {
  host: SessionHost;
  session: Session;
  messageIds: ReadonlyArray<string>;
}): Promise<BegunFlow> {
  const { own } = host.flows;
  const turn = await session.record?.redelivered(messageIds);
  if (turn?.version === undefined || turn.version === own.version || turn.flow === undefined) {
    return own;
  }
  const { threadId } = session.runner;
  const rebuilt = await host.flows.rebuild(turn.executionId, turn.version);
  if (rebuilt === undefined) {
    return own;
  }
  if (isRebuildFailure(rebuilt)) {
    emitFrameworkEvent({
      broadcaster: session.runner.broadcaster,
      agentName: host.agentName,
      eventType: 'flow_rebuild_failed',
      data: {
        threadId,
        executionId: turn.executionId,
        ...rebuilt,
      },
    });
    return {
      ...own,
      failure: rebuilt,
    };
  }
  return rebuilt;
}

/** Save the park and queued messages before letting the host wake the turn. */
async function closeOutPark(host: SessionHost, session: Session, ctx: Context): Promise<boolean> {
  const { record } = session;
  const { threadId } = session.runner;
  const wakeAt = parkedUntil(ctx);
  if (wakeAt === undefined || !record) {
    return false;
  }
  await keepQueuedMessages(session, record);
  const until = Number.isFinite(wakeAt) ? wakeAt : undefined;
  await record.park(ctx, until);
  host.cuts?.forget(threadId);
  await host.connections.release(ctx.id);
  host.parkWatchers?.watch(threadId, {
    executionId: ctx.id,
    until,
    options: session.turnOptions,
  });
  // Before the turn answers as parked: whoever wakes it has to know when.
  await host.announceWakeTime();
  return true;
}

async function runTurn({
  host,
  session,
  ctx,
  signal,
}: {
  host: SessionHost;
  session: Session;
  ctx: Context;
  signal: AbortSignal;
}): Promise<string> {
  const { threadId } = session.runner;
  const graph = session.turnGraph;
  if (!graph) {
    await host.connections.release(ctx.id);
    throw new NoeticConfigError({
      code: 'NO_STEP_CONFIGURED',
      message: 'No agentGraph configured on this harness.',
      hint: 'Pass `agentGraph` in constructor options.',
    });
  }
  // Wire signal-abort to context-abort so the interpreter bails cleanly.
  if (signal.aborted) {
    ctx.abort(signal.reason ? String(signal.reason) : 'aborted');
  } else {
    signal.addEventListener(
      'abort',
      () => {
        ctx.abort(signal.reason ? String(signal.reason) : 'aborted');
      },
      {
        once: true,
      },
    );
  }
  const result = await host.run(graph, ctx).catch((error: unknown) =>
    failTurn({
      host,
      session,
      ctx,
      error,
    }),
  );
  // A flow that caught the wait's cancellation and returned is parked all the
  // same: the wait it was in has not ended, and the woken turn goes back to it.
  if (result === CUT || result === PARKED || (await closeOutPark(host, session, ctx))) {
    return '';
  }
  if (
    await keepOrCut({
      host,
      session,
      ctx,
      keep: () =>
        keepHistory({
          host,
          session,
          ctx,
          answer: result,
        }),
    })
  ) {
    return '';
  }
  host.parkWatchers?.forget(threadId, ctx.id);
  await host.announceWakeTimeQuietly();
  return result;
}

async function failTurn({
  host,
  session,
  ctx,
  error,
}: {
  host: SessionHost;
  session: Session;
  ctx: Context;
  error: unknown;
}): Promise<typeof PARKED | typeof CUT> {
  const { record } = session;
  const { threadId } = session.runner;
  // An interrupted turn restarts from what it finished, so the
  // interrupting message lands after the work it interrupted.
  if (ctx.abortReason === INTERRUPT_REASON) {
    await keepHistory({
      host,
      session,
      ctx,
    });
  }
  // A parked turn is not a failed one: its record stays, marked with when
  // to wake it, and the response says so.
  if (await closeOutPark(host, session, ctx)) {
    return PARKED;
  }
  // Cut short with everything before the stop on record: run again later.
  if (
    await closeOutCut({
      host,
      session,
      ctx,
      error,
    })
  ) {
    return CUT;
  }
  host.cuts?.forget(threadId);
  // The turn ended here, in a live process. Say so, or a routine wake would
  // take it for one cut off by a crash and run it again, every time.
  // It stopped rather than redo a recorded effect under a newer flow version:
  // it waits, marked, for the host to settle it.
  const stuck = stuckOf(error);
  if (record && stuck) {
    await record.stick(ctx, stuck);
    await host.announceWakeTimeQuietly();
    throw error;
  }
  // A harness that was replaced says nothing about the turn: it is the new
  // holder's now, and marking it stopped would keep a wake from resuming it.
  const replaced = isLeaseLost(error) || session.lease?.lost === true;
  // An interrupted turn answers its held calls "Cancelled before it ran." in
  // the history it restarts from: no answer could reach them any more.
  if (ctx.aborted && !replaced) {
    await host.holds.clear(ctx.id);
  }
  if (record && !replaced && ctx.abortReason !== INTERRUPT_REASON) {
    await record.stop(ctx, error instanceof Error ? error.message : String(error), host.now());
  }
  await host.announceWakeTimeQuietly();
  throw error;
}

//#endregion

//#region Durable turn outcomes

/**
 * A turn stopped by `lease_lost` or `ledger_write_failed` is cut, not failed
 * (spec 23 § Cut turns): its record stays, marked, and a wake runs it again once
 * its back-off is over. Resolves false when `error` does not cut the turn, or the
 * turn has been cut as often as it may be and fails instead.
 */
async function closeOutCut({
  host,
  session,
  ctx,
  error,
}: {
  host: SessionHost;
  session: Session;
  ctx: Context;
  error: unknown;
}): Promise<boolean> {
  const { record } = session;
  const { threadId } = session.runner;
  const reason = host.cuts?.reasonOf(error);
  if (!reason || !record || !host.cuts || !host.leaseOptions) {
    return false;
  }
  // The storage that refused a write may refuse this read: the mark in memory counts then.
  const stored = await record.turn().catch(() => undefined);
  if (reason === 'lease_lost') {
    return closeOutLostLease({
      host,
      threadId,
      ctx,
      stored,
    });
  }
  const messageIds = stored?.executionId === ctx.id ? stored.messageIds : session.turnMessageIds;
  const mark = host.cuts.cut(
    threadId,
    {
      messageIds: messageIds ?? [],
      cut: stored?.executionId === ctx.id ? stored.cut : undefined,
    },
    reason,
    host.now(),
  );
  if (!mark) {
    return false;
  }
  await record.cut(ctx, mark);
  await keepQueuedMessages(session, record);
  host.cutOfContext.set(ctx, {
    reason,
    attempt: mark.count,
    wakeAt: host.cuts.dueAt(mark),
  });
  // Before the turn answers as cut: whoever wakes it has to know when.
  await host.announceWakeTimeQuietly();
  return true;
}

/**
 * Another holder took the turn (spec 23 § Cut turns, A replaced harness). The
 * turn is theirs: this harness writes nothing to it, counts nothing, and leaves
 * its own queue alone. It is cut only while it is still on record under this
 * execution, when a wake can pick it up should that holder die; otherwise the
 * other holder ended it, and the response fails as before.
 */
async function closeOutLostLease({
  host,
  threadId,
  ctx,
  stored,
}: {
  host: SessionHost;
  threadId: string;
  ctx: Context;
  stored: StoredTurnRecord | undefined;
}): Promise<boolean> {
  if (!host.leaseOptions || stored?.executionId !== ctx.id || stored.parked || stored.stopped) {
    return false;
  }
  const heldUntil = await heldElsewhereUntil(host.leaseOptions, threadId).catch(() => undefined);
  host.cutOfContext.set(ctx, {
    reason: 'lease_lost',
    wakeAt: heldUntil ?? host.now(),
  });
  await host.announceWakeTimeQuietly();
  return true;
}

/**
 * Record the end of a turn whose work is done. Resolves true when that write was
 * refused and the turn was cut instead: a wake replays it to here.
 */
async function keepOrCut({
  host,
  session,
  ctx,
  keep,
}: {
  host: SessionHost;
  session: Session;
  ctx: Context;
  keep: () => Promise<void>;
}): Promise<boolean> {
  try {
    await keep();
    return false;
  } catch (error) {
    if (
      await closeOutCut({
        host,
        session,
        ctx,
        error,
      })
    ) {
      return true;
    }
    host.cuts?.forget(session.runner.threadId);
    throw error;
  }
}

/** Start the stored turn before putting kept messages back or reporting drops. */
async function beginStoredTurn({
  host,
  session,
  record,
  ctx,
  messageIds,
  flow,
  keptSteers,
}: {
  host: SessionHost;
  session: Session;
  record: ThreadRecord;
  ctx: Context;
  messageIds: ReadonlyArray<string>;
  flow: BegunFlow;
  keptSteers: KeptSteers | undefined;
}): Promise<void> {
  const stored = await storeTurnFlow({
    host,
    record,
    ctx,
    flow,
  });
  const { removed, kept } = await splitKeptMessages({
    session,
    record,
    messageIds,
    keptSteers,
  });
  try {
    await record.begin(
      ctx,
      messageIds,
      {
        version: flow.version,
        stored,
        rebuild: flow.failure,
      },
      removed.map((steer) => steer.id),
    );
  } catch (error) {
    await host.connections.release(ctx.id);
    throw error;
  }

  for (const message of kept) {
    session.keptOptions.delete(message.id);
    if (!session.runner.queue.peekAll().some((queued) => queued.id === message.id)) {
      session.runner.queue.enqueue(message);
    }
  }
  const saved = removed.length > 0 && ctx instanceof ContextImpl ? savedItemIds(ctx) : undefined;
  // Told only once the record no longer holds them.
  for (const steer of removed) {
    if (saved && steerInConversation(steerItems(steer), (id) => saved.has(id))) {
      continue;
    }
    emitFrameworkEvent({
      broadcaster: session.runner.broadcaster,
      agentName: host.agentName,
      eventType: 'steer_dropped',
      data: {
        messageId: steer.id,
        reason: 'kept_steers',
      },
    });
  }
}

/**
 * Split stored messages between the queue and the steers the start write clears.
 */
async function splitKeptMessages({
  session,
  record,
  messageIds,
  keptSteers,
}: {
  session: Session;
  record: ThreadRecord;
  messageIds: ReadonlyArray<string>;
  keptSteers: KeptSteers | undefined;
}): Promise<{
  removed: QueuedMessage[];
  kept: QueuedMessage[];
}> {
  const removed: QueuedMessage[] = [];
  const kept: QueuedMessage[] = [];
  for (const steer of await record.steers()) {
    const queued = session.runner.queue.peekAll().some((m) => m.id === steer.id);
    if (queued || messageIds.includes(steer.id)) {
      continue;
    }
    // With the options it was sent with, when this process is the one it was sent to.
    const options = session.keptOptions.get(steer.id);
    // A message this process kept for a parked turn still has its sender here.
    if (keptSteers === 'drop' && options === undefined && isSteer(steer)) {
      removed.push(steer);
      continue;
    }
    kept.push({
      ...steer,
      options: options ?? steer.options,
    });
  }
  return {
    removed,
    kept,
  };
}

/**
 * Messages that reached the runner while the thread's turn is parked or stuck
 * (one that landed as the turn was closing out, say). Starting a turn with them
 * would throw the waiting one away, so they are kept in storage for after it. A
 * steer wakes a parked turn, as one delivered a moment later would. An
 * `interrupt` is not set aside: replacing the turn is what it asks for.
 * Resolves true when the messages were set aside.
 */
async function setAside({
  host,
  session,
  record,
  messages,
}: {
  host: SessionHost;
  session: Session;
  record: ThreadRecord;
  messages: ReadonlyArray<QueuedMessage>;
}): Promise<boolean> {
  const turn = await record.turn();
  const cut = turn ? host.cuts?.markOf(session.runner.threadId, turn) : undefined;
  if (!turn || (!turn.parked && !turn.stuck && !cut)) {
    return false;
  }
  if (messages.some((message) => message.deliveryMode === 'interrupt')) {
    return false;
  }
  if (messages.every((message) => turn.messageIds.includes(message.id))) {
    return false;
  }
  for (const message of messages) {
    if (!turn.messageIds.includes(message.id)) {
      await keepForLater(session, record, message);
    }
  }
  if (turn.parked && messages.some(isSteer)) {
    const { threadId } = session.runner;
    void session.runner.whenIdle().then(() =>
      host.wake({
        threadId,
        options: messages[0]?.options,
      }),
    );
  }
  return true;
}

/** Hand the turn's lease back and return the thread record to best-effort writes. */
async function releaseLease(session: Session): Promise<void> {
  const lease = session.lease;
  session.lease = undefined;
  session.record?.hold(undefined);
  await lease?.release();
}

function bindLease(
  ctx: Context,
  lease: TurnLease | undefined,
  parkGraceMs: number | undefined,
): void {
  if (lease) {
    lease.bind(ctx.id);
    if (ctx instanceof ContextImpl) {
      ctx.ledger?.fence(lease);
    }
    lease.keep((reason) => ctx.abort(`lease_lost: ${reason}`));
    if (parkGraceMs !== undefined && ctx instanceof ContextImpl) {
      ctx.ledger?.parking.arm({
        graceMs: parkGraceMs,
        onPark: () => ctx.abort(PARK_REASON),
      });
    }
  }
}

/** What a `turn_stuck` error says about where the turn stopped, or undefined for any other error. */
function stuckOf(error: unknown):
  | {
      path: string;
      from: string;
      to: string;
    }
  | undefined {
  const ending = turnEndingIn(error)?.noeticError;
  if (ending?.kind !== 'turn_stuck') {
    return undefined;
  }
  const { path, from, to } = ending;
  return {
    path,
    from,
    to,
  };
}

function isLeaseLost(error: unknown): boolean {
  return isNoeticError(error) && error.noeticError.kind === 'lease_lost';
}

/** What a turn's run resolves to when it parked instead of finishing. */
const PARKED: unique symbol = Symbol('parked');

/** What a turn's run resolves to when it was cut instead of failing (spec 23 § Cut turns). */
const CUT: unique symbol = Symbol('cut');

/** When the turn on `ctx` parked until, or undefined when it did not park. */
function parkedUntil(ctx: Context): number | undefined {
  if (ctx.abortReason !== PARK_REASON || !(ctx instanceof ContextImpl)) {
    return undefined;
  }
  return ctx.ledger?.parking.parkedUntil;
}

//#endregion
