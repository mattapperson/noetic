/**
 * Per-task agent IPC server (Node-backed).
 *
 * A runner subprocess opens a unix-domain socket and exposes its
 * `AgentHarness` over a newline-delimited JSON protocol
 * (`agent-ipc-protocol.ts`). A client (typically a TUI) connects,
 * replays prior chat history, subscribes to the live item/event
 * streams, and submits user messages through the same
 * `harness.execute()` path the in-process chat uses.
 *
 * This module lives in `@noetic-tools/core/adapters/node` because it
 * imports `node:net` and `node:path`. Non-Node consumers would
 * implement an alternative transport against the `agent-ipc-protocol`
 * wire shape.
 *
 * The server is task-domain-agnostic: it talks to a `ChatHistoryStore`
 * for history persistence, a `TaskLogger` callback for operational
 * logs, and an `IpcAskUserService` for the ask-user modal bridge. The
 * concrete implementations of those collaborators live in
 * `@noetic-tools/code-agent` and are wired at construction time — this
 * module never imports the task-domain package.
 */

import { unlinkSync } from 'node:fs';
import type { Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import type {
  AgentHarnessContract,
  AskUserOutput,
  FsAdapter,
  HarnessStatus,
  Item,
  StorageAdapter,
  StreamEvent,
  StreamingItem,
} from '@noetic-tools/core';
import { ZodError } from 'zod';

import type { AskUserPendingFrame, ClientFrame, ServerFrame } from './agent-ipc-protocol';
import { encodeFrame, PROTOCOL_VERSION, parseClientFrame } from './agent-ipc-protocol';
import type { DurableOutboundQueue } from './durable-outbound-queue';
import { createDurableOutboundQueue } from './durable-outbound-queue';

//#region Types

/**
 * The minimum subset of `AgentHarness` the IPC server uses. Defining
 * this as a structural interface (rather than coupling to the concrete
 * `AgentHarness<...>` class) lets tests pass a stub without casts.
 */
export interface IpcHarness {
  execute(
    input: string,
    options?: {
      threadId?: string;
      messageId?: string;
    },
  ): Promise<void>;
  getItemStream(scope?: { threadId?: string }): AsyncIterable<StreamingItem>;
  getFullStream(scope?: { threadId?: string }): AsyncIterable<StreamEvent>;
  getStatus(scope?: { threadId?: string }): HarnessStatus;
  abort(scope?: { threadId?: string; reason?: string }): Promise<void>;
}

// `AgentHarness<{model: string}>` from core satisfies `IpcHarness`
// structurally; this re-export keeps the dependency on the core's
// contract types explicit so a refactor of the core's runtime methods
// breaks here loudly.
export type { AgentHarnessContract };

/**
 * Structural chat-history persistence the server uses. Callers provide
 * an object bound to a specific `taskId`-agnostic backing store — the
 * server passes `taskId` on every call. Concrete implementations in
 * `@noetic-tools/code-agent` adapt the on-disk `<taskDir>/chat.jsonl` store.
 */
export interface ChatHistoryStore {
  /**
   * Return every persisted item for `taskId` in append order, or `[]`
   * if no history exists yet.
   */
  readChatHistory(taskId: string): Promise<Item[]>;
  /**
   * Append a single item to `taskId`'s history. Must be atomic with
   * respect to concurrent calls within a single process.
   */
  appendChatItem(taskId: string, item: Item): Promise<void>;
}

/**
 * Structural entry the server passes to the task logger on internal
 * errors. Callers map `kind` onto whatever enum their persistence
 * layer uses — the server only produces `'system'` today, but the
 * field is kept open so callers can reject or re-tag entries without
 * a core change.
 */
export interface TaskLogEntry {
  readonly kind: string;
  readonly ts: string;
  readonly message: string;
  readonly meta?: Record<string, unknown>;
}

/**
 * Async logger the server calls on internal errors (socket bind
 * failures, stream-pump exceptions, client parse errors). The server
 * never throws from a logger call — a logger that rejects is
 * silently swallowed so logging doesn't loop.
 */
export type TaskLogger = (taskId: string, entry: TaskLogEntry) => Promise<void>;

/**
 * Structural bridge to the ask-user service the runner threads through
 * its tool registration. The server uses it to (a) replay outstanding
 * requests to late-joining clients via `peek()`, (b) route
 * `askUserResolve` / `askUserCancel` client frames into the service,
 * and (c) cancel any pending request on close so a runner shutdown
 * doesn't strand the agent's awaiting tool call.
 */
export interface IpcAskUserService {
  /** Current pending request, or null. */
  peek(): AskUserPendingFrame | null;
  /** Forward a client `askUserResolve` frame into the service. */
  handleResolve(id: string, output: AskUserOutput): void;
  /** Forward a client `askUserCancel` frame into the service. */
  handleCancel(id: string, reason: string): void;
  /** Cancel any currently-pending request. Called on server close. */
  cancelAll(reason: string): void;
}

export interface AgentIpcServerOpts {
  readonly harness: IpcHarness;
  readonly chatHistoryStore: ChatHistoryStore;
  readonly logger: TaskLogger;
  readonly taskId: string;
  readonly role: string;
  readonly runnerId: string;
  readonly threadId: string;
  /**
   * Absolute path to the unix-domain socket. The server cleans stale
   * sockets at this path before listening and unlinks on close.
   */
  readonly socketPath: string;
  /**
   * IPC-backed ask-user service the runner threads through its tool
   * registration. Consulted on subscribe + routed resolve/cancel
   * frames + cancelled on close.
   */
  readonly askUserService: IpcAskUserService;
  /**
   * FsAdapter used to prepare the socket directory (mkdir) and clear a
   * stale socket (rm) before listening. Required — the SDK stays
   * portable by never reaching for a local adapter implicitly.
   */
  readonly fs: FsAdapter;
  /**
   * Optional storage adapter that, when supplied, opts the server into
   * durable outbound delivery. Stream frames (`item`, `event`,
   * `askUserRequest`, `askUserCleared`) get monotonic sequence numbers
   * and are persisted under `durableOutboundQueue:<socketId>:…` until
   * a client acks them. A reconnecting client that issues
   * `durableResume` replays every un-acked frame exactly once.
   *
   * When omitted the server behaves identically to the pre-durability
   * implementation — no queue, no wrapping, `durableResume`/`durableAck`
   * frames from over-eager clients are silently dropped.
   */
  readonly storage?: StorageAdapter;
}

interface ClientState {
  readonly socket: Socket;
  /** Buffer for partial frames between `data` events. */
  buffer: string;
  /** Whether this client has issued `subscribe`. */
  subscribed: boolean;
}

interface FrameContext {
  readonly server: AgentIpcServer;
  readonly client: ClientState;
}

type FrameHandler = (frame: ClientFrame, ctx: FrameContext) => Promise<void>;

//#endregion

//#region Helpers

/**
 * Conservative cross-platform max for unix-domain socket path bytes.
 * macOS allows 104; Linux allows 108. We use the macOS limit so a path
 * that works on macOS works everywhere we care about.
 */
const MAX_UNIX_SOCKET_PATH_BYTES = 104;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasStringCode(err: unknown): err is Error & {
  code: string;
} {
  if (!(err instanceof Error)) {
    return false;
  }
  if (!('code' in err)) {
    return false;
  }
  // 'code' in err narrows err to { code: unknown } — read without casting.
  return typeof err.code === 'string';
}

function isErrorWithCode(err: unknown, code: string): boolean {
  if (!hasStringCode(err)) {
    return false;
  }
  return err.code === code;
}

function isAddressInUse(err: unknown): boolean {
  return isErrorWithCode(err, 'EADDRINUSE');
}

function isEnoent(err: unknown): boolean {
  return isErrorWithCode(err, 'ENOENT');
}

/**
 * Drop the framework-only `isComplete` field from a `StreamingItem` so
 * the result satisfies the plain `Item` union expected by callers like
 * `appendChatItem` (which round-trips through `seedSessionHistory`).
 */
function stripIsComplete(streamingItem: StreamingItem): Item {
  const { isComplete: _isComplete, ...rest } = streamingItem;
  return rest;
}

function writeFrame(socket: Socket, frame: ServerFrame): void {
  if (socket.destroyed || !socket.writable) {
    return;
  }
  try {
    socket.write(encodeFrame(frame));
  } catch {
    // Synchronous write throw is rare but possible (e.g. socket entered
    // an erroring state between the `destroyed` check and the call).
    // Swallow — the socket's `'close'` handler will remove the client
    // from the set on the next tick.
  }
}

function broadcastFrame(clients: ReadonlySet<ClientState>, frame: ServerFrame): void {
  for (const client of clients) {
    if (!client.subscribed) {
      continue;
    }
    writeFrame(client.socket, frame);
  }
}

/**
 * Narrow a parsed durable-frame payload to the `askUserRequest` shape.
 * Used by `handleDurableResume` to decide whether the replay already
 * covered the current pending ask-user (so a follow-up peek emission
 * would duplicate).
 */
function isAskUserRequestFrame(value: unknown): value is {
  type: 'askUserRequest';
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('type' in value)) {
    return false;
  }
  return value.type === 'askUserRequest';
}

/**
 * Synchronous unlink of a socket file. Used as a last-resort cleanup
 * from `process.on('exit', …)` where async fs operations don't run.
 * Errors are swallowed — the next runner that tries to bind to the
 * same path calls `removeStaleSocket` anyway.
 */
export function unlinkSocketSync(socketPath: string): void {
  try {
    unlinkSync(socketPath);
  } catch {
    // ignore
  }
}

//#endregion

//#region Frame handler registry

async function handleSubscribe(_frame: ClientFrame, ctx: FrameContext): Promise<void> {
  if (ctx.client.subscribed) {
    return;
  }
  ctx.client.subscribed = true;
  writeFrame(ctx.client.socket, {
    type: 'status',
    status: ctx.server.harness.getStatus({
      threadId: ctx.server.threadId,
    }),
  });
  // Peek-replay of the current pending ask-user request is skipped
  // when durability is enabled — a resuming client receives the
  // request via the durable queue's `durableResume` replay instead,
  // and replaying it here would deliver a second (non-durable) copy
  // that the client has no seq to dedupe against.
  if (ctx.server.getDurableQueue() !== null) {
    return;
  }
  const pending = ctx.server.askUserService.peek();
  if (pending !== null) {
    writeFrame(ctx.client.socket, {
      type: 'askUserRequest',
      request: pending,
    });
  }
}

async function handleGetHistory(_frame: ClientFrame, ctx: FrameContext): Promise<void> {
  const items = await ctx.server.loadHistorySnapshot();
  writeFrame(ctx.client.socket, {
    type: 'history',
    items,
  });
}

async function handleSend(frame: ClientFrame, ctx: FrameContext): Promise<void> {
  if (frame.type !== 'send') {
    return;
  }
  await ctx.server.harness.execute(frame.text, {
    threadId: ctx.server.threadId,
    messageId: frame.messageId,
  });
  writeFrame(ctx.client.socket, {
    type: 'ack',
    messageId: frame.messageId,
  });
}

async function handleGetStatus(_frame: ClientFrame, ctx: FrameContext): Promise<void> {
  writeFrame(ctx.client.socket, {
    type: 'status',
    status: ctx.server.harness.getStatus({
      threadId: ctx.server.threadId,
    }),
  });
}

async function handleAbort(frame: ClientFrame, ctx: FrameContext): Promise<void> {
  if (frame.type !== 'abort') {
    return;
  }
  await ctx.server.harness.abort({
    threadId: ctx.server.threadId,
    reason: frame.reason,
  });
}

async function handleAskUserResolve(frame: ClientFrame, ctx: FrameContext): Promise<void> {
  if (frame.type !== 'askUserResolve') {
    return;
  }
  ctx.server.askUserService.handleResolve(frame.id, frame.output);
}

async function handleAskUserCancel(frame: ClientFrame, ctx: FrameContext): Promise<void> {
  if (frame.type !== 'askUserCancel') {
    return;
  }
  ctx.server.askUserService.handleCancel(frame.id, frame.reason ?? 'user cancelled');
}

async function handleDurableResume(frame: ClientFrame, ctx: FrameContext): Promise<void> {
  if (frame.type !== 'durableResume') {
    return;
  }
  const queue = ctx.server.getDurableQueue();
  if (queue === null) {
    // Non-durable server — resume frames are a no-op. Clients that
    // speculatively send `durableResume` to any server won't get an
    // error response.
    return;
  }
  const entries = await queue.frameRange(frame.ackedThrough + 1);
  let replayedAskUserRequest = false;
  for (const entry of entries) {
    let inner: unknown;
    try {
      inner = JSON.parse(entry.frame);
    } catch {
      // Skip malformed persisted frames rather than poisoning the
      // whole replay; the server's log would have captured the
      // original append if it had gone wrong.
      continue;
    }
    writeFrame(ctx.client.socket, {
      type: 'durable',
      seq: entry.seq,
      frame: inner,
    });
    if (isAskUserRequestFrame(inner)) {
      replayedAskUserRequest = true;
    }
  }
  // If replay did not surface the current pending ask-user (because
  // the client acked past it before disconnecting, or the queue was
  // compacted), deliver it as a point-in-time plain frame to this
  // client only. Skipping when replay already sent one prevents a
  // duplicate push — only one ask-user is pending at a time, so any
  // replayed `askUserRequest` is necessarily the current one.
  if (replayedAskUserRequest) {
    return;
  }
  const pending = ctx.server.askUserService.peek();
  if (pending !== null) {
    writeFrame(ctx.client.socket, {
      type: 'askUserRequest',
      request: pending,
    });
  }
}

async function handleDurableAck(frame: ClientFrame, ctx: FrameContext): Promise<void> {
  if (frame.type !== 'durableAck') {
    return;
  }
  const queue = ctx.server.getDurableQueue();
  if (queue === null) {
    return;
  }
  await queue.ackUpTo(frame.throughSeq);
}

const FRAME_HANDLERS: Record<ClientFrame['type'], FrameHandler> = {
  subscribe: handleSubscribe,
  getHistory: handleGetHistory,
  send: handleSend,
  getStatus: handleGetStatus,
  abort: handleAbort,
  askUserResolve: handleAskUserResolve,
  askUserCancel: handleAskUserCancel,
  durableResume: handleDurableResume,
  durableAck: handleDurableAck,
};

//#endregion

//#region Public API

export class AgentIpcServer {
  readonly threadId: string;
  readonly harness: IpcHarness;
  readonly askUserService: IpcAskUserService;

  private readonly chatHistoryStore: ChatHistoryStore;
  private readonly logger: TaskLogger;
  private readonly taskId: string;
  private readonly role: string;
  private readonly runnerId: string;
  private readonly clients = new Set<ClientState>();
  private readonly socketPath: string;
  private readonly fs: FsAdapter;
  private readonly storage: StorageAdapter | null;
  private durableQueue: DurableOutboundQueue | null = null;
  private server: Server | null = null;
  private streamPumpStopped = false;
  private closed = false;

  constructor(opts: AgentIpcServerOpts) {
    this.harness = opts.harness;
    this.chatHistoryStore = opts.chatHistoryStore;
    this.logger = opts.logger;
    this.taskId = opts.taskId;
    this.role = opts.role;
    this.runnerId = opts.runnerId;
    this.threadId = opts.threadId;
    this.askUserService = opts.askUserService;
    this.fs = opts.fs;
    this.socketPath = opts.socketPath;
    this.storage = opts.storage ?? null;
  }

  /**
   * Fan an ask-user request out to every subscribed client. The runner
   * constructs the IPC-backed `AskUserService` with a broadcaster that
   * forwards into this method, so the service stays unaware of sockets.
   */
  broadcastAskUserRequest(request: AskUserPendingFrame): void {
    void this.appendAndBroadcastDurable({
      type: 'askUserRequest',
      request,
    });
  }

  /**
   * Notify subscribed clients that a previously-broadcast request has
   * been resolved or cancelled.
   */
  broadcastAskUserCleared(id: string): void {
    void this.appendAndBroadcastDurable({
      type: 'askUserCleared',
      id,
    });
  }

  /**
   * Underlying durable queue, or null when the server was constructed
   * without a `storage` option. Exposed for frame handlers and tests;
   * callers should not mutate the queue directly.
   */
  getDurableQueue(): DurableOutboundQueue | null {
    return this.durableQueue;
  }

  /**
   * Number of frames currently awaiting client acknowledgement. Zero
   * when durability is disabled. Exposed for test assertions.
   */
  async queueSize(): Promise<number> {
    if (this.durableQueue === null) {
      return 0;
    }
    return this.durableQueue.queueSize();
  }

  /**
   * Append a stream frame to the durable queue (when enabled) and
   * broadcast it to subscribed clients. The wire shape sent depends
   * on whether durability is in effect:
   *
   *   - With a queue: `{type: 'durable', seq, frame}` — clients
   *     dedupe by seq and ack up to a watermark.
   *   - Without: the frame is emitted as-is, matching pre-durability
   *     behaviour exactly.
   */
  async appendAndBroadcastDurable(frame: ServerFrame): Promise<void> {
    if (this.durableQueue === null) {
      broadcastFrame(this.clients, frame);
      return;
    }
    const entry = await this.durableQueue.append(JSON.stringify(frame));
    broadcastFrame(this.clients, {
      type: 'durable',
      seq: entry.seq,
      frame,
    });
  }

  /** Absolute path of the unix-domain socket this server is bound to. */
  getSocketPath(): string {
    return this.socketPath;
  }

  async loadHistorySnapshot(): Promise<Item[]> {
    return this.chatHistoryStore.readChatHistory(this.taskId);
  }

  /**
   * Bind the socket and begin accepting connections. Removes a stale socket
   * file (left by a crashed runner) before bind. Resolves once the socket
   * is listening; rejects if the address is already in use after cleanup.
   */
  async listen(): Promise<void> {
    if (this.server) {
      throw new Error('AgentIpcServer.listen() called twice');
    }
    const pathByteLength = new TextEncoder().encode(this.socketPath).length;
    if (pathByteLength > MAX_UNIX_SOCKET_PATH_BYTES) {
      throw new Error(
        `unix-domain socket path exceeds ${MAX_UNIX_SOCKET_PATH_BYTES} bytes ` +
          `(${pathByteLength}): ${this.socketPath}. ` +
          'Move the project to a shorter path or set NOETIC_RUNTIME_DIR to a ' +
          'shorter base (e.g. /tmp/n).',
      );
    }
    await this.fs.mkdir(dirname(this.socketPath));
    await this.removeStaleSocket();
    if (this.storage !== null) {
      this.durableQueue = await createDurableOutboundQueue({
        storage: this.storage,
        socketPath: this.socketPath,
      });
    }
    const server = createServer((socket) => {
      this.acceptConnection(socket);
    });
    server.on('error', (err) => {
      this.logServerError(`server error: ${errorMessage(err)}`);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: unknown): void => {
        server.removeListener('listening', onListening);
        reject(isAddressInUse(err) ? new Error(`socket in use: ${this.socketPath}`) : err);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.socketPath);
    });
    void this.pumpItemStream();
    void this.pumpEventStream();
  }

  /**
   * Stop accepting new connections, send `bye` to current clients, and
   * remove the socket file. Idempotent.
   */
  async close(reason?: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.streamPumpStopped = true;
    this.askUserService.cancelAll(reason ?? 'agent ipc server closed');
    for (const client of this.clients) {
      writeFrame(client.socket, {
        type: 'bye',
        reason,
      });
      client.socket.end();
    }
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    await this.removeStaleSocket();
  }

  private async removeStaleSocket(): Promise<void> {
    try {
      await this.fs.rm(this.socketPath, {
        force: true,
      });
    } catch (err) {
      if (isEnoent(err)) {
        return;
      }
      throw err;
    }
  }

  private logServerError(message: string): void {
    void this.logger(this.taskId, {
      kind: 'system',
      ts: new Date().toISOString(),
      message: `agent-ipc-server: ${message}`,
    }).catch(() => {
      // Best-effort: don't loop trying to log a logging failure.
    });
  }

  private acceptConnection(socket: Socket): void {
    const client: ClientState = {
      socket,
      buffer: '',
      subscribed: false,
    };
    this.clients.add(client);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.handleSocketData(client, chunk);
    });
    socket.on('error', (err) => {
      this.logServerError(`client socket error: ${errorMessage(err)}`);
    });
    socket.on('close', () => {
      this.clients.delete(client);
    });
    writeFrame(socket, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      taskId: this.taskId,
      role: this.role,
      runnerId: this.runnerId,
      threadId: this.threadId,
    });
  }

  private handleSocketData(client: ClientState, chunk: string): void {
    client.buffer += chunk;
    let nl = client.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = client.buffer.slice(0, nl);
      client.buffer = client.buffer.slice(nl + 1);
      if (line.length > 0) {
        void this.dispatchLine(client, line);
      }
      nl = client.buffer.indexOf('\n');
    }
  }

  private async dispatchLine(client: ClientState, line: string): Promise<void> {
    let frame: ClientFrame;
    try {
      frame = parseClientFrame(line);
    } catch (err) {
      const kind = err instanceof ZodError ? 'invalid_frame' : 'parse_error';
      writeFrame(client.socket, {
        type: 'error',
        error: {
          kind,
          message: errorMessage(err),
        },
      });
      return;
    }
    const handler = FRAME_HANDLERS[frame.type];
    if (!handler) {
      writeFrame(client.socket, {
        type: 'error',
        error: {
          kind: 'unknown_frame',
          message: `no handler for frame type: ${frame.type}`,
        },
      });
      return;
    }
    try {
      await handler(frame, {
        server: this,
        client,
      });
    } catch (err) {
      writeFrame(client.socket, {
        type: 'error',
        error: {
          kind: 'handler_error',
          message: errorMessage(err),
        },
      });
    }
  }

  private async pumpItemStream(): Promise<void> {
    const stream = this.harness.getItemStream({
      threadId: this.threadId,
    });
    try {
      for await (const streamingItem of stream) {
        if (this.streamPumpStopped) {
          return;
        }
        if (streamingItem.isComplete) {
          await this.chatHistoryStore.appendChatItem(this.taskId, stripIsComplete(streamingItem));
        }
        await this.appendAndBroadcastDurable({
          type: 'item',
          item: streamingItem,
        });
      }
    } catch (err) {
      if (this.streamPumpStopped) {
        return;
      }
      this.logServerError(`item stream: ${errorMessage(err)}`);
    }
  }

  private async pumpEventStream(): Promise<void> {
    const stream = this.harness.getFullStream({
      threadId: this.threadId,
    });
    try {
      for await (const event of stream) {
        if (this.streamPumpStopped) {
          return;
        }
        await this.appendAndBroadcastDurable({
          type: 'event',
          event,
        });
      }
    } catch (err) {
      if (this.streamPumpStopped) {
        return;
      }
      this.logServerError(`event stream: ${errorMessage(err)}`);
    }
  }
}

//#endregion
