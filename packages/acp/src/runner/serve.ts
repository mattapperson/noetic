/**
 * The remote runner: started where the agent should run, it runs what a host asks
 * for over one channel — the agent with its launch settings, MCP servers
 * beside it — and serves the host's tool bridge to them on a loopback port.
 *
 * Every channel is one session: when it closes, everything it started stops.
 * Over WebSocket each upgrade must carry the runner's bearer token, and a
 * listener off the loopback interface must use TLS.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import * as https from 'node:https';
import { Readable, Writable } from 'node:stream';
import type { AcpTransport, AcpWhenHostExits } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { WebSocketServer } from 'ws';
import type { KeeperLink } from '../keeper/client';
import { attachKeeper, isKeeperAddress, keeperHandleOf, startKeeper } from '../keeper/client';
import { serverEnv } from '../server-env';
import type { AcpRunnerGrant } from './grants';
import { checkStart } from './grants';
import type { FrameLink, HostFrame } from './protocol';
import {
  chunksOf,
  fromBase64,
  HostFrameSchema,
  isLoopbackHost,
  lineFrameLink,
  toBase64,
} from './protocol';
import { webSocketFrameLink } from './ws-link';

//#region Types

/** @public Options for {@link serveAcpRunner}. */
export interface AcpRunnerOptions {
  /**
   * Only these commands may be started, compared by executable and
   * arguments, each with only its own environment names, in a working
   * directory inside `cwd`.
   */
  allow?: ReadonlyArray<AcpRunnerGrant>;
  /** Working directory for a start that names none. */
  cwd?: string;
  /**
   * How long an agent a host keeps may run with no host attached before its
   * keeper stops it. Default `0`: until a host reattaches or it exits.
   */
  detachedTimeoutMs?: number;
}

/** @public Options for {@link listenAcpRunner}. */
export interface AcpRunnerListenOptions extends AcpRunnerOptions {
  host?: string;
  port?: number;
  /** Every WebSocket upgrade must send `Authorization: Bearer <token>`. */
  token: string;
  /** PEM certificate and key. Required off the loopback interface. */
  tls?: {
    cert: string;
    key: string;
  };
}

/** @public A listening runner. */
export interface AcpRunnerListener {
  /** `ws://` or `wss://` URL hosts connect to. */
  readonly url: string;
  close(): Promise<void>;
}

interface Session {
  readonly link: FrameLink;
  readonly options: AcpRunnerOptions;
  readonly children: Map<string, ChildProcess>;
  readonly ports: Server[];
  readonly responses: Map<string, ServerResponse>;
  next: number;
  /** Set by a `keep` frame: this channel's agents run through a keeper. */
  keep?: AcpWhenHostExits;
  keeper?: Promise<KeeperLink | undefined>;
  /** Streams of kept agents, by stream id. */
  readonly kept: Map<string, KeptStream>;
}

interface KeptStream {
  readonly transport: AcpTransport;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
}

type Handler<F extends HostFrame['t']> = (
  session: Session,
  frame: Extract<
    HostFrame,
    {
      t: F;
    }
  >,
) => void | Promise<void>;

//#endregion

//#region Public API

/**
 * Serve one host over `link` until it closes.
 * @public
 */
export function serveAcpRunner(link: FrameLink, options: AcpRunnerOptions = {}): Promise<void> {
  const session: Session = {
    link,
    options,
    children: new Map(),
    ports: [],
    responses: new Map(),
    next: 0,
    kept: new Map(),
  };
  return new Promise<void>((resolve) => {
    link.onFrame((raw) => {
      void receive(session, raw);
    });
    link.onClose(() => {
      release(session);
      resolve();
    });
  });
}

/**
 * Serve one host over this process's stdin and stdout — for a runner started
 * by `ssh` or `docker exec`, whose own channel is already private.
 * @public
 */
export function serveAcpRunnerOverStdio(options: AcpRunnerOptions = {}): Promise<void> {
  return serveAcpRunner(
    lineFrameLink(
      frameworkCast<ReadableStream<Uint8Array>>(Readable.toWeb(process.stdin)),
      frameworkCast<WritableStream<Uint8Array>>(Writable.toWeb(process.stdout)),
      async () => undefined,
    ),
    options,
  );
}

/**
 * Listen for hosts over WebSocket. Each connection is its own session.
 * @public
 */
export async function listenAcpRunner(options: AcpRunnerListenOptions): Promise<AcpRunnerListener> {
  const host = options.host ?? '127.0.0.1';
  if (!options.tls && !isLoopbackHost(host)) {
    throw new TypeError(
      `A runner listening on ${host} must use TLS: pass a certificate and key, or listen on 127.0.0.1.`,
    );
  }
  if (options.token.length < 16) {
    throw new TypeError('The runner token must be at least 16 characters.');
  }
  const server = options.tls
    ? https.createServer({
        cert: options.tls.cert,
        key: options.tls.key,
      })
    : createServer();
  const sockets = new WebSocketServer({
    server,
    verifyClient: (info: { req: IncomingMessage }) =>
      sameSecret(info.req.headers.authorization, `Bearer ${options.token}`),
  });
  sockets.on('connection', (socket) => {
    void serveAcpRunner(webSocketFrameLink(socket), options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The runner did not bind a TCP port.');
  }
  const shown = host.includes(':') ? `[${host}]` : host;
  return {
    url: `${options.tls ? 'wss' : 'ws'}://${shown}:${address.port}`,
    async close() {
      for (const client of sockets.clients) {
        client.terminate();
      }
      sockets.close();
      // Under Bun a socket upgraded moments ago can hold the server's close
      // callback back for good, so the wait is bounded.
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        setTimeout(resolve, 1e3).unref();
      });
    },
  };
}

//#endregion

//#region Handlers

const handlers: { [F in HostFrame['t']]: Handler<F> } = {
  reach: openPort,
  start: startProcess,
  stdin: (session, frame) => {
    const kept = session.kept.get(frame.id);
    if (kept) {
      void kept.writer.write(fromBase64(frame.data)).catch(() => undefined);
      return;
    }
    session.children.get(frame.id)?.stdin?.write(fromBase64(frame.data));
  },
  kill: async (session, frame) => {
    const kept = session.kept.get(frame.id);
    if (kept) {
      // The host closes its agent on purpose: stop it, keeper and all.
      session.kept.delete(frame.id);
      await kept.transport.close();
      return;
    }
    session.children.get(frame.id)?.kill();
  },
  keep: (session, frame) => {
    session.keep = frame.whenHostExits;
  },
  attach: attachKept,
  response: (session, frame) => {
    const res = session.responses.get(frame.id);
    if (!res || res.headersSent) {
      return;
    }
    res.writeHead(frame.status, frame.headers.flat());
  },
  body: (session, frame) => {
    session.responses.get(frame.id)?.write(fromBase64(frame.data));
  },
  end: (session, frame) => {
    session.responses.get(frame.id)?.end();
    session.responses.delete(frame.id);
  },
};

async function receive(session: Session, raw: unknown): Promise<void> {
  const parsed = HostFrameSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  const frame = parsed.data;
  const handler = frameworkCast<Handler<typeof frame.t>>(handlers[frame.t]);
  try {
    await handler(session, frame);
  } catch (e) {
    session.link.send({
      t: 'error',
      id: frame.id,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * A loopback port on this machine whose requests the host answers from its
 * bridge. The host's bridge checks the token, host, and origin itself.
 */
async function openPort(
  session: Session,
  frame: Extract<
    HostFrame,
    {
      t: 'reach';
    }
  >,
): Promise<void> {
  const server = createServer((req, res) => {
    void relay(session, req, res);
  });
  session.ports.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The bridge port did not bind.');
  }
  const local = `http://127.0.0.1:${address.port}${frame.path}`;
  // A kept agent reaches the bridge on its keeper's port, which outlives this
  // channel; the keeper forwards to this channel's port while it is open.
  const keeper = await openKeeper(session);
  session.link.send({
    t: 'reached',
    id: frame.id,
    url: keeper ? await keeper.reach(frame.path, local) : local,
  });
}

async function relay(session: Session, req: IncomingMessage, res: ServerResponse): Promise<void> {
  session.next += 1;
  const id = `r${session.next}`;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  session.responses.set(id, res);
  res.on('close', () => {
    if (session.responses.delete(id)) {
      session.link.send({
        t: 'abort',
        id,
      });
    }
  });
  const headers: Array<
    [
      string,
      string,
    ]
  > = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers.push([
      req.rawHeaders[i] ?? '',
      req.rawHeaders[i + 1] ?? '',
    ]);
  }
  session.link.send({
    t: 'request',
    id,
    method: req.method ?? 'GET',
    path: req.url ?? '/',
    headers,
    body: toBase64(Buffer.concat(chunks)),
  });
}

async function startProcess(
  session: Session,
  frame: Extract<
    HostFrame,
    {
      t: 'start';
    }
  >,
): Promise<void> {
  const checked = checkStart(frame, session.options);
  const keeper = frame.kind === 'launch' ? await openKeeper(session) : undefined;
  if (keeper) {
    const transport = await keeper.launch({
      command: frame.command,
      args: frame.args,
      cwd: checked.cwd,
      env: {
        ...process.env,
        ...checked.env,
      },
    });
    carryKept(session, frame.id, transport);
    return;
  }
  // An MCP server gets what the MCP SDK would give it here, the agent all of the runner's.
  const env =
    frame.kind === 'spawn'
      ? serverEnv(checked.env)
      : {
          ...process.env,
          ...checked.env,
        };
  const child = spawn(frame.command, frame.args, {
    cwd: checked.cwd,
    env,
    stdio: [
      'pipe',
      'pipe',
      'inherit',
    ],
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  session.children.set(frame.id, child);
  // A write after the process exits must not take the runner down with it.
  child.stdin?.on('error', () => undefined);
  child.stdout?.on('data', (chunk: Buffer) => {
    session.link.send({
      t: 'stdout',
      id: frame.id,
      data: toBase64(chunk),
    });
  });
  child.once('exit', (code) => {
    session.children.delete(frame.id);
    session.link.send({
      t: 'exit',
      id: frame.id,
      code,
    });
  });
  session.link.send({
    t: 'started',
    id: frame.id,
  });
}

/** Start this channel's keeper on first use, when the host keeps its agents. */
function openKeeper(session: Session): Promise<KeeperLink | undefined> {
  const whenHostExits = session.keep;
  if (!whenHostExits) {
    return Promise.resolve(undefined);
  }
  session.keeper ??= startKeeper('runner', {
    whenHostExits,
    detachedTimeoutMs: session.options.detachedTimeoutMs ?? 0,
  });
  return session.keeper;
}

/** Send a kept agent's output as stream `id` until it ends. */
async function pumpKept(session: Session, id: string, transport: AcpTransport): Promise<void> {
  for await (const chunk of chunksOf(transport.readable)) {
    session.link.send({
      t: 'stdout',
      id,
      data: toBase64(chunk),
    });
  }
  session.kept.delete(id);
  session.link.send({
    t: 'exit',
    id,
    code: null,
  });
}

/** Carry a kept agent's stream over this channel as stream `id`. */
function carryKept(session: Session, id: string, transport: AcpTransport): void {
  session.kept.set(id, {
    transport,
    writer: transport.writable.getWriter(),
  });
  void pumpKept(session, id, transport).catch(() => undefined);
  session.link.send({
    t: 'started',
    id,
    reattach: transport.reattach,
  });
}

/** Take over an agent an earlier channel launched and kept. */
async function attachKept(
  session: Session,
  frame: Extract<
    HostFrame,
    {
      t: 'attach';
    }
  >,
): Promise<void> {
  const handle = keeperHandleOf(frame.handle);
  if (!handle || !isKeeperAddress(handle.address)) {
    throw new Error('The handle names no keeper on this runner.');
  }
  const link = await attachKeeper('runner', handle, session.keep ?? 'keep');
  session.keeper = Promise.resolve(link);
  carryKept(session, frame.id, link.transport());
}

//#endregion

//#region Helpers

function release(session: Session): void {
  for (const child of session.children.values()) {
    child.kill();
  }
  session.children.clear();
  for (const server of session.ports) {
    server.close();
    server.closeAllConnections();
  }
  for (const res of session.responses.values()) {
    res.destroy();
  }
  session.responses.clear();
  // A kept agent is let go, not stopped: its keeper decides (`whenHostExits`).
  session.kept.clear();
  void session.keeper?.then((link) => link?.detach());
}

function sameSecret(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A token for a runner started without one. */
export function newRunnerToken(): string {
  return randomUUID();
}

/** Read a PEM file for {@link AcpRunnerListenOptions.tls}. */
export function readPem(path: string): string {
  return readFileSync(path, 'utf8');
}

//#endregion
