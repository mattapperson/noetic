/**
 * Per-task agent IPC server.
 *
 * A runner subprocess opens a unix-domain socket inside `<taskDir>/sockets/`
 * and exposes its `AgentHarness` over a newline-delimited JSON protocol
 * (`agent-ipc-protocol.ts`). The TUI connects, replays prior chat history,
 * subscribes to the live item/event streams, and submits user messages
 * through the same `harness.execute()` path the in-process chat uses.
 *
 * Lifecycle:
 *   1. Caller constructs a server with the runner's harness, role, runnerId,
 *      threadId, and store context.
 *   2. Caller awaits `server.listen()`. The server creates the socket
 *      directory if needed, removes a stale socket file (if any), binds,
 *      and begins accepting connections.
 *   3. The runner subscribes the harness streams to chat-history persistence
 *      so every emitted item is durably appended to `<taskDir>/chat.jsonl`
 *      before any client receives it.
 *   4. On runner shutdown, caller awaits `server.close()`. The socket file
 *      is unlinked. Open client connections receive a `bye` frame.
 *
 * Multiple clients may subscribe simultaneously (e.g. the TUI plus a CLI
 * inspector) — the server fans out items and events to every subscribed
 * connection.
 *
 * The server also owns an `IpcAskUserService` so headless runners can
 * register the `AskUserQuestion` tool: when the agent calls the tool,
 * the service fans out an `askUserRequest` frame to subscribed clients,
 * and clients return answers via `askUserResolve` / `askUserCancel`
 * frames. Pending requests are replayed to late-joining clients so a
 * reconnecting TUI sees the outstanding question instead of blanking.
 */

import { unlinkSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import type { Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import { dirname } from 'node:path';

import type {
  AgentHarnessContract,
  HarnessStatus,
  Item,
  StreamEvent,
  StreamingItem,
} from '@noetic/core';
import { ZodError } from 'zod';
import type { PendingAskUserRequest } from '../../../tui/services/ask-user-service.js';
import type { ClientFrame, ServerFrame } from './agent-ipc-protocol.js';
import { encodeFrame, PROTOCOL_VERSION, parseClientFrame } from './agent-ipc-protocol.js';
import type { ChatHistoryStoreContext } from './chat-history-store.js';
import { appendChatItem, readChatHistory } from './chat-history-store.js';
import { appendLog } from './fs-store.js';
import type { IpcAskUserService } from './ipc-ask-user-service.js';
import { runnerSocketPath } from './paths.js';
import { LogEntryKind } from './schemas.js';

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

export interface AgentIpcServerOpts {
  readonly harness: IpcHarness;
  readonly storeCtx: ChatHistoryStoreContext;
  readonly taskId: string;
  readonly role: string;
  readonly runnerId: string;
  readonly threadId: string;
  /**
   * IPC-backed ask-user service the runner threads through its tool
   * registration. The server uses it to (a) replay outstanding requests
   * to late-joining clients, (b) route `askUserResolve` / `askUserCancel`
   * client frames into the service, and (c) cancel any pending request
   * on close so a runner shutdown doesn't strand the agent's awaiting
   * tool call.
   *
   * The service's broadcaster (constructed by the runner) is expected
   * to forward into this server's `broadcastAskUserRequest` /
   * `broadcastAskUserCleared` methods so events propagate to subscribed
   * clients.
   */
  readonly askUserService: IpcAskUserService;
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

/**
 * Drop the framework-only `isComplete` field from a `StreamingItem` so
 * the result satisfies the plain `Item` union expected by callers like
 * `appendChatItem` (which round-trips through `seedSessionHistory`).
 */
function stripIsComplete(streamingItem: StreamingItem): Item {
  const { isComplete: _isComplete, ...rest } = streamingItem;
  return rest;
}

function isErrorWithCode(err: unknown, code: string): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (!('code' in err)) {
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
  // Send the current status so the client can render its connection
  // state. History is *not* sent here — clients fetch it explicitly via
  // `getHistory` to avoid double-sends and to keep `subscribe`
  // round-trips small (see `agent-ipc-client.ts:useTaskChat` flow).
  writeFrame(ctx.client.socket, {
    type: 'status',
    status: ctx.server.harness.getStatus({
      threadId: ctx.server.threadId,
    }),
  });
  // Replay any outstanding ask-user request so a late-joining client
  // (e.g. TUI reconnecting after a network blip) sees the modal it
  // would otherwise have missed.
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

const FRAME_HANDLERS: Record<ClientFrame['type'], FrameHandler> = {
  subscribe: handleSubscribe,
  getHistory: handleGetHistory,
  send: handleSend,
  getStatus: handleGetStatus,
  abort: handleAbort,
  askUserResolve: handleAskUserResolve,
  askUserCancel: handleAskUserCancel,
};

//#endregion

//#region Public API

export class AgentIpcServer {
  readonly threadId: string;
  readonly harness: IpcHarness;
  readonly askUserService: IpcAskUserService;

  private readonly storeCtx: ChatHistoryStoreContext;
  private readonly taskId: string;
  private readonly role: string;
  private readonly runnerId: string;
  private readonly clients = new Set<ClientState>();
  private readonly socketPath: string;
  private server: Server | null = null;
  private streamPumpStopped = false;
  private closed = false;

  constructor(opts: AgentIpcServerOpts) {
    this.harness = opts.harness;
    this.storeCtx = opts.storeCtx;
    this.taskId = opts.taskId;
    this.role = opts.role;
    this.runnerId = opts.runnerId;
    this.threadId = opts.threadId;
    this.askUserService = opts.askUserService;
    // Singleton roles (planner) pass the role as their runnerId and
    // land on `<taskDir>/sockets/planner.sock`; multi-instance roles
    // (implementer) pass a distinguishing runnerId (featureId) and
    // land on `<taskDir>/sockets/implementer-<featureId>.sock`.
    const runnerIdArg = opts.runnerId === opts.role ? undefined : opts.runnerId;
    this.socketPath = runnerSocketPath(opts.storeCtx, {
      taskId: opts.taskId,
      role: opts.role,
      runnerId: runnerIdArg,
    });
  }

  /**
   * Fan an ask-user request out to every subscribed client. The runner
   * constructs the IPC-backed `AskUserService` with a broadcaster that
   * forwards into this method, so the service stays unaware of sockets.
   */
  broadcastAskUserRequest(request: PendingAskUserRequest): void {
    broadcastFrame(this.clients, {
      type: 'askUserRequest',
      request,
    });
  }

  /**
   * Notify subscribed clients that a previously-broadcast request has
   * been resolved or cancelled. Idempotent — late frames against an
   * already-cleared id are harmless on the client side (they just
   * close a modal that's already gone).
   */
  broadcastAskUserCleared(id: string): void {
    broadcastFrame(this.clients, {
      type: 'askUserCleared',
      id,
    });
  }

  /** Absolute path of the unix-domain socket this server is bound to. */
  getSocketPath(): string {
    return this.socketPath;
  }

  async loadHistorySnapshot(): Promise<Item[]> {
    return readChatHistory(this.storeCtx, this.taskId);
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
    // Unix-domain sockets have a hard path-length limit baked into the
    // kernel: 104 bytes on macOS / 108 on Linux. We surface a helpful
    // error rather than letting `bind` fail with `ENAMETOOLONG`, which
    // a detached runner would otherwise log to /dev/null and silently
    // hang. 104 is the conservative cross-platform bound.
    const socketPathBytes = Buffer.byteLength(this.socketPath, 'utf8');
    if (socketPathBytes > MAX_UNIX_SOCKET_PATH_BYTES) {
      throw new Error(
        `unix-domain socket path exceeds ${MAX_UNIX_SOCKET_PATH_BYTES} bytes ` +
          `(${socketPathBytes}): ${this.socketPath}. ` +
          'Set NOETIC_HOME to a shorter base (e.g. NOETIC_HOME=/tmp/n) so ' +
          'runner sockets land under a short path. Your task data will ' +
          'live at <NOETIC_HOME>/tasks/<taskId>/.',
      );
    }
    await mkdir(dirname(this.socketPath), {
      recursive: true,
    });
    await this.removeStaleSocket();
    const server = createServer((socket) => {
      this.acceptConnection(socket);
    });
    server.on('error', (err) => {
      // Surface listen errors via the task log (stderr is /dev/null for
      // detached subprocesses); the runner exits on its own when its
      // top-level await rejects, so we don't kill the process here.
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
    // Reject any outstanding ask-user request so the agent's awaiting
    // tool call doesn't hang past server shutdown.
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
      await rm(this.socketPath, {
        force: true,
      });
    } catch (err) {
      if (isEnoent(err)) {
        return;
      }
      throw err;
    }
  }

  /**
   * Append an IPC server error to the task's `log.jsonl`. The runner is
   * spawned with `stdio: 'ignore'` so plain `process.stderr.write` would
   * disappear into `/dev/null`; the audit log is the durable surface
   * the user (and the TUI's task-detail view) reads.
   */
  private logServerError(message: string): void {
    void appendLog(this.storeCtx, {
      taskId: this.taskId,
      entry: {
        kind: LogEntryKind.System,
        ts: new Date().toISOString(),
        message: `agent-ipc-server: ${message}`,
      },
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

  /**
   * Subscribe to the harness item stream and (a) persist every item to
   * `<taskDir>/chat.jsonl` (b) fan out to subscribed clients. Persistence
   * happens before fan-out so a crash between the two doesn't lose state
   * the client never received either.
   */
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
          // Persist the underlying Item without the framework-only
          // `isComplete` field — the harness's `Item` union does not
          // include it, and seedSessionHistory replays this back into
          // an Item-typed accumulated-items array.
          await appendChatItem(this.storeCtx, this.taskId, stripIsComplete(streamingItem));
        }
        broadcastFrame(this.clients, {
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
        broadcastFrame(this.clients, {
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
