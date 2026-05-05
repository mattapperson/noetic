/**
 * Client for the per-task agent IPC server (`agent-ipc-server.ts`).
 *
 * Connects to a runner's unix-domain socket, validates frames via Zod
 * (the same protocol module the server uses), and exposes:
 *
 *   - `connect()` opens the connection and resolves once the server's
 *     `hello` frame is received.
 *   - `send(text)` queues a user message via the runner's `harness.execute()`.
 *   - `getHistory()` returns the seeded chat-history snapshot.
 *   - `subscribe()` switches to streaming mode and returns AsyncIterables
 *     for incoming items, framework events, and ask-user state changes.
 *   - `resolveAskUser(id, output)` / `cancelAskUser(id, reason)` answer
 *     a server-issued `askUserRequest`.
 *   - `close()` gracefully tears the connection down.
 *
 * The client never assumes the server is the same process — frame
 * boundaries are line-delimited JSON, partial reads buffer until a
 * full line arrives, and any frame that fails Zod validation surfaces
 * as a `protocol-error` rejection on outstanding promises.
 */

import type { Socket } from 'node:net';
import { createConnection } from 'node:net';

import { z } from 'zod';

import type { AskUserOutput } from '../../types/ask-user-types';
import type { AskUserPendingFrame, ServerFrame } from './agent-ipc-protocol';
import { encodeFrame, parseServerFrame } from './agent-ipc-protocol';

//#region Types

export interface HelloInfo {
  readonly protocolVersion: number;
  readonly taskId: string;
  readonly role: string;
  readonly runnerId: string;
  readonly threadId: string;
}

export interface AgentIpcClientOpts {
  readonly socketPath: string;
}

/**
 * Discriminated event the `askUser` subscription stream emits. `pending`
 * carries a new outstanding request; `cleared` signals the request with
 * `id` has been resolved or cancelled (by us or by another client). The
 * UI uses these to show/dismiss the modal.
 */
export type AskUserStreamEvent =
  | {
      readonly kind: 'pending';
      readonly request: AskUserPendingFrame;
    }
  | {
      readonly kind: 'cleared';
      readonly id: string;
    };

interface PendingDeferred<T> {
  resolve(value: T): void;
  reject(err: unknown): void;
}

interface SubscriptionStreams {
  pushItem(item: unknown): void;
  pushEvent(event: unknown): void;
  pushAskUser(event: AskUserStreamEvent): void;
  close(): void;
}

//#endregion

//#region Helpers

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Create an AsyncIterable backed by an internal queue plus a settled
 * flag. Producers call `push(value)` to enqueue and `close()` to mark
 * the stream done; the iterator yields buffered items in FIFO order
 * and ends after `close()` is called and the buffer drains.
 */
function makeQueueIterable<T>(): {
  iter: AsyncIterable<T>;
  push(value: T): void;
  close(): void;
} {
  const queue: T[] = [];
  let closed = false;
  let resolveNext: (() => void) | null = null;

  function notify(): void {
    if (resolveNext === null) {
      return;
    }
    const fn = resolveNext;
    resolveNext = null;
    fn();
  }

  return {
    iter: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          async next(): Promise<IteratorResult<T>> {
            for (;;) {
              const head = queue.shift();
              if (head !== undefined) {
                return {
                  value: head,
                  done: false,
                };
              }
              if (closed) {
                return {
                  value: undefined,
                  done: true,
                };
              }
              await new Promise<void>((resolve) => {
                resolveNext = resolve;
              });
            }
          },
        };
      },
    },
    push(value) {
      queue.push(value);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
  };
}

//#endregion

//#region Public API

export class AgentIpcClient {
  private socket: Socket | null = null;
  private buffer = '';
  private hello: HelloInfo | null = null;
  private connectDeferred: PendingDeferred<HelloInfo> | null = null;
  private historyDeferred: PendingDeferred<ReadonlyArray<unknown>> | null = null;
  private statusDeferred: PendingDeferred<unknown> | null = null;
  private pendingAcks = new Map<string, PendingDeferred<void>>();
  private subscriptionStreams: SubscriptionStreams | null = null;
  private subscribed = false;
  private closed = false;
  private closeError: Error | null = null;
  /** Last non-fatal error observed via a server `error` frame. */
  private lastError: Error | null = null;
  /**
   * Highest durable seq the client has delivered to its subscribers.
   * Emitted in `durableResume` on reconnect and advanced whenever a
   * new durable frame unwraps.
   */
  private highestDeliveredDurableSeq = 0;
  /** Highest durable seq already acknowledged to the server. */
  private lastAckedDurableSeq = 0;

  constructor(private readonly opts: AgentIpcClientOpts) {}

  /**
   * Connect to the unix-domain socket. Resolves with the server's
   * `hello` frame; rejects if the underlying socket errors before hello
   * arrives.
   */
  connect(): Promise<HelloInfo> {
    if (this.socket !== null) {
      return Promise.reject(new Error('AgentIpcClient.connect() called twice'));
    }
    return new Promise<HelloInfo>((resolve, reject) => {
      this.connectDeferred = {
        resolve,
        reject,
      };
      const socket = createConnection(this.opts.socketPath);
      this.socket = socket;
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        this.handleData(chunk);
      });
      socket.on('error', (err) => {
        this.handleSocketError(err);
      });
      socket.on('close', () => {
        this.handleSocketClose();
      });
    });
  }

  /**
   * Switch to streaming mode. Returns AsyncIterables for items,
   * framework events, and ask-user state changes. Calling
   * `subscribe()` more than once returns the same streams (idempotent).
   */
  subscribe(): {
    readonly items: AsyncIterable<unknown>;
    readonly events: AsyncIterable<unknown>;
    readonly askUser: AsyncIterable<AskUserStreamEvent>;
  } {
    this.requireConnected();
    if (this.subscriptionStreams === null) {
      const items = makeQueueIterable<unknown>();
      const events = makeQueueIterable<unknown>();
      const askUser = makeQueueIterable<AskUserStreamEvent>();
      this.subscriptionStreams = {
        pushItem: items.push,
        pushEvent: events.push,
        pushAskUser: askUser.push,
        close: () => {
          items.close();
          events.close();
          askUser.close();
        },
      };
      this.writeFrame({
        type: 'subscribe',
      });
      this.subscribed = true;
      return {
        items: items.iter,
        events: events.iter,
        askUser: askUser.iter,
      };
    }
    // Re-derive iterables from the existing pump on a second call. We
    // recreate the queues so a late-binding consumer doesn't miss items
    // already pushed to the original.
    const itemsAgain = makeQueueIterable<unknown>();
    const eventsAgain = makeQueueIterable<unknown>();
    const askUserAgain = makeQueueIterable<AskUserStreamEvent>();
    const previous = this.subscriptionStreams;
    this.subscriptionStreams = {
      pushItem: (v) => {
        previous.pushItem(v);
        itemsAgain.push(v);
      },
      pushEvent: (v) => {
        previous.pushEvent(v);
        eventsAgain.push(v);
      },
      pushAskUser: (v) => {
        previous.pushAskUser(v);
        askUserAgain.push(v);
      },
      close: () => {
        previous.close();
        itemsAgain.close();
        eventsAgain.close();
        askUserAgain.close();
      },
    };
    return {
      items: itemsAgain.iter,
      events: eventsAgain.iter,
      askUser: askUserAgain.iter,
    };
  }

  /** Request the seeded chat-history snapshot. */
  getHistory(): Promise<ReadonlyArray<unknown>> {
    this.requireConnected();
    if (this.historyDeferred !== null) {
      return Promise.reject(new Error('AgentIpcClient: history request already in flight'));
    }
    return new Promise<ReadonlyArray<unknown>>((resolve, reject) => {
      this.historyDeferred = {
        resolve,
        reject,
      };
      this.writeFrame({
        type: 'getHistory',
      });
    });
  }

  /**
   * Request the runner's current status (idle / generating / aborting).
   * Resolves when the server's reply frame arrives.
   */
  getStatus(): Promise<unknown> {
    this.requireConnected();
    if (this.statusDeferred !== null) {
      return Promise.reject(new Error('AgentIpcClient: status request already in flight'));
    }
    return new Promise<unknown>((resolve, reject) => {
      this.statusDeferred = {
        resolve,
        reject,
      };
      this.writeFrame({
        type: 'getStatus',
      });
    });
  }

  /**
   * Send a user message; resolves when the server has acked it. The
   * message goes through the runner's `harness.execute(text, …)` exactly
   * the same way the main TUI's chat input does.
   */
  send(args: { messageId: string; text: string }): Promise<void> {
    this.requireConnected();
    if (this.pendingAcks.has(args.messageId)) {
      return Promise.reject(new Error(`messageId already in flight: ${args.messageId}`));
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingAcks.set(args.messageId, {
        resolve,
        reject,
      });
      this.writeFrame({
        type: 'send',
        messageId: args.messageId,
        text: args.text,
      });
    });
  }

  /** Ask the runner to abort any in-flight turn. */
  abort(reason?: string): void {
    this.requireConnected();
    this.writeFrame({
      type: 'abort',
      reason,
    });
  }

  /**
   * Resolve a pending ask-user request with the user's answer. The
   * server forwards the output to its IPC-backed `AskUserService`,
   * which resolves the agent's awaiting tool call.
   */
  resolveAskUser(id: string, output: AskUserOutput): void {
    this.requireConnected();
    this.writeFrame({
      type: 'askUserResolve',
      id,
      output,
    });
  }

  /**
   * Cancel a pending ask-user request. The server rejects the agent's
   * awaiting tool call with a `cancelled` error.
   */
  cancelAskUser(id: string, reason?: string): void {
    this.requireConnected();
    this.writeFrame({
      type: 'askUserCancel',
      id,
      reason,
    });
  }

  //#region Durable outbound (protocol v2)

  /**
   * Emit a `durableResume` frame carrying the highest durable seq this
   * client has already delivered. Servers that have adopted the
   * `DurableOutboundQueue` path replay every frame with seq >
   * `ackedThrough`. Safe to call for servers that don't — they ignore
   * the frame because they never assigned any durable seqs.
   *
   * Callers typically invoke this immediately after `connect()` on a
   * reconnect that should resume a prior session. Pass `null` (or omit)
   * to use the client's own tracked `highestDeliveredDurableSeq`; pass
   * a specific value when resuming against an externally-persisted
   * watermark.
   */
  sendDurableResume(ackedThrough?: number): void {
    this.requireConnected();
    const watermark = ackedThrough ?? this.highestDeliveredDurableSeq;
    this.writeFrame({
      type: 'durableResume',
      ackedThrough: watermark,
    });
  }

  /**
   * Acknowledge every durable frame with seq ≤ `throughSeq` as
   * successfully processed. The server drops them from its persisted
   * queue. A caller that aggregates delivery confirmations (e.g. an
   * IPC-backed TUI) pumps this periodically to keep the server's
   * on-disk footprint bounded.
   *
   * No-op when `throughSeq` is at or below the current ack watermark.
   */
  acknowledgeDurableFrames(throughSeq: number): void {
    this.requireConnected();
    if (throughSeq <= this.lastAckedDurableSeq) {
      return;
    }
    this.lastAckedDurableSeq = throughSeq;
    this.writeFrame({
      type: 'durableAck',
      throughSeq,
    });
  }

  /** Highest durable seq surfaced to subscription streams. */
  getHighestDeliveredDurableSeq(): number {
    return this.highestDeliveredDurableSeq;
  }

  /** Highest durable seq already acked back to the server. */
  getLastAckedDurableSeq(): number {
    return this.lastAckedDurableSeq;
  }

  //#endregion

  /**
   * Close the connection. Idempotent. Pending promises reject with the
   * close reason.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.end();
      socket.destroy();
    }
    this.failPending(new Error('AgentIpcClient closed'));
    this.subscriptionStreams?.close();
    this.subscriptionStreams = null;
  }

  private requireConnected(): void {
    if (this.closed) {
      throw new Error('AgentIpcClient is closed');
    }
    if (this.socket === null) {
      throw new Error('AgentIpcClient not connected — call connect() first');
    }
  }

  private writeFrame(frame: Parameters<typeof encodeFrame>[0]): void {
    const socket = this.socket;
    if (socket === null) {
      return;
    }
    socket.write(encodeFrame(frame));
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) {
        this.dispatchLine(line);
      }
      nl = this.buffer.indexOf('\n');
    }
  }

  private dispatchLine(line: string): void {
    let frame: ServerFrame;
    try {
      frame = parseServerFrame(line);
    } catch (err) {
      const wrapped =
        err instanceof z.ZodError
          ? new Error(`agent-ipc-client: invalid server frame: ${errorMessage(err)}`)
          : new Error(`agent-ipc-client: bad frame parse: ${errorMessage(err)}`);
      this.fatalError(wrapped);
      return;
    }
    this.handleFrame(frame);
  }

  private handleFrame(frame: ServerFrame): void {
    if (frame.type === 'hello') {
      const info: HelloInfo = {
        protocolVersion: frame.protocolVersion,
        taskId: frame.taskId,
        role: frame.role,
        runnerId: frame.runnerId,
        threadId: frame.threadId,
      };
      this.hello = info;
      const deferred = this.connectDeferred;
      this.connectDeferred = null;
      deferred?.resolve(info);
      return;
    }
    if (frame.type === 'history') {
      const deferred = this.historyDeferred;
      this.historyDeferred = null;
      deferred?.resolve(frame.items);
      return;
    }
    if (frame.type === 'item') {
      this.subscriptionStreams?.pushItem(frame.item);
      return;
    }
    if (frame.type === 'event') {
      this.subscriptionStreams?.pushEvent(frame.event);
      return;
    }
    if (frame.type === 'status') {
      const deferred = this.statusDeferred;
      this.statusDeferred = null;
      deferred?.resolve(frame.status);
      return;
    }
    if (frame.type === 'ack') {
      const pending = this.pendingAcks.get(frame.messageId);
      if (pending) {
        this.pendingAcks.delete(frame.messageId);
        pending.resolve();
      }
      return;
    }
    if (frame.type === 'askUserRequest') {
      this.subscriptionStreams?.pushAskUser({
        kind: 'pending',
        request: frame.request,
      });
      return;
    }
    if (frame.type === 'askUserCleared') {
      this.subscriptionStreams?.pushAskUser({
        kind: 'cleared',
        id: frame.id,
      });
      return;
    }
    if (frame.type === 'error') {
      // Error frames are non-fatal: a single bad frame from a peer or a
      // transient handler exception should not tear down the chat
      // connection. Surface to any in-flight `send` ack waiter so that
      // call rejects, and stash the error so callers can inspect it via
      // `getLastError()`. Streaming continues.
      const err = new Error(`server error (${frame.error.kind}): ${frame.error.message}`);
      this.lastError = err;
      // Server only emits acks against `send`; the only deferred we can
      // reasonably correlate is one of the pending send waiters. Without
      // a messageId on the error frame we can't pinpoint which — fail
      // them all so a chained `await client.send(...)` doesn't hang.
      for (const pending of this.pendingAcks.values()) {
        pending.reject(err);
      }
      this.pendingAcks.clear();
      return;
    }
    if (frame.type === 'bye') {
      this.close();
      return;
    }
    if (frame.type === 'durable') {
      this.handleDurableFrame(frame.seq, frame.frame);
      return;
    }
  }

  /**
   * Unwrap a server-side durable wrapper. Dedupes on the wrapper's seq
   * so a replay after reconnect doesn't redeliver frames the client
   * already surfaced. Once the inner frame is parsed, we re-enter
   * `handleFrame` so subscription streams + pending promises fire
   * exactly as they would for a non-durable delivery.
   */
  private handleDurableFrame(seq: number, inner: unknown): void {
    if (seq <= this.highestDeliveredDurableSeq) {
      // Replay of an already-delivered frame. Drop it silently — the
      // server is required to keep frames persisted until we ack, so
      // duplicates after a resume are expected.
      return;
    }
    let innerFrame: ServerFrame;
    try {
      // The inner frame is carried as `unknown` in the wire schema to
      // dodge recursive Zod typing; re-parse here using the full
      // ServerFrame validator. A failure is treated as fatal because
      // it means the server emitted a malformed payload.
      innerFrame = parseServerFrame(JSON.stringify(inner));
    } catch (err) {
      const wrapped =
        err instanceof z.ZodError
          ? new Error(`agent-ipc-client: invalid durable inner frame: ${errorMessage(err)}`)
          : new Error(`agent-ipc-client: bad durable inner frame: ${errorMessage(err)}`);
      this.fatalError(wrapped);
      return;
    }
    if (innerFrame.type === 'durable') {
      // Nested durable frames are not legal — treat as malformed.
      this.fatalError(new Error('agent-ipc-client: nested durable frames are not allowed'));
      return;
    }
    this.highestDeliveredDurableSeq = seq;
    this.handleFrame(innerFrame);
  }

  private handleSocketError(err: Error): void {
    this.fatalError(err);
  }

  private handleSocketClose(): void {
    this.close();
  }

  private fatalError(err: Error): void {
    this.closeError = err;
    this.failPending(err);
    this.close();
  }

  private failPending(err: unknown): void {
    if (this.connectDeferred !== null) {
      this.connectDeferred.reject(err);
      this.connectDeferred = null;
    }
    if (this.historyDeferred !== null) {
      this.historyDeferred.reject(err);
      this.historyDeferred = null;
    }
    if (this.statusDeferred !== null) {
      this.statusDeferred.reject(err);
      this.statusDeferred = null;
    }
    for (const deferred of this.pendingAcks.values()) {
      deferred.reject(err);
    }
    this.pendingAcks.clear();
  }

  /** Server-issued hello info. Null until `connect()` resolves. */
  getHelloInfo(): HelloInfo | null {
    return this.hello;
  }

  /** Was this client subscribed to streaming mode? */
  isSubscribed(): boolean {
    return this.subscribed;
  }

  /** Last fatal error; `null` if the client closed cleanly. */
  getCloseError(): Error | null {
    return this.closeError;
  }

  /** Last non-fatal error received via a server `error` frame. */
  getLastError(): Error | null {
    return this.lastError;
  }
}

//#endregion
