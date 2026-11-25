/**
 * The keeper: a small detached process that runs one local agent for its
 * host and keeps it running when the host goes away.
 *
 * It owns the agent's stdio and relays its ACP stream (`relay.ts`) to whichever
 * host is attached over a private local socket — a Unix socket in a directory
 * only its user can open, or a named pipe on Windows — that every connection
 * must open with the keeper's token. It also owns the loopback port the agent
 * reaches the host's tool bridge on, so the agent's MCP settings stay valid
 * when a later host serves the bridge.
 *
 * When the attached host's connection drops without a `stop`, the keeper
 * either stops the agent (`whenHostExits: 'stop'`) or keeps it working and
 * holds what it sends until a host attaches again, for at most
 * `detachedTimeoutMs`. It exits when the agent does.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { appendFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import * as http from 'node:http';
import type { Socket } from 'node:net';
import * as net from 'node:net';
import { frameworkCast } from '@noetic-tools/types';
import { stopProcessTree } from '../stdio-process';
import type { KeeperConfig, KeeperHostLine, KeeperLine } from './protocol';
import { isControlLine, KeeperHostLineSchema, LineSplitter } from './protocol';
import { AcpRelay } from './relay';

//#region Types

interface HeldRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly body: Buffer;
}

/** A loopback port the agent reaches the host's bridge on. */
interface Port {
  readonly server: Server;
  readonly url: string;
  /** The attached host's bridge, or none while no host serves one. */
  target?: URL;
  /** Requests that arrived while no bridge was there to answer them. */
  readonly held: HeldRequest[];
}

type ControlHandler<K extends KeeperHostLine['keeper']> = (
  line: Extract<
    KeeperHostLine,
    {
      keeper: K;
    }
  >,
) => void | Promise<void>;

//#endregion

//#region Constants

/** Request headers that belong to one hop. */
const HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
]);

/** Connection errors that mean the request never reached a bridge. */
const UNDELIVERED = new Set([
  'ECONNREFUSED',
  'ENOENT',
  'ECONNRESET',
]);

//#endregion

//#region Helpers

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

//#endregion

//#region Keeper

class Keeper {
  private host?: Socket;
  private agent?: ChildProcess;
  private whenHostExits: 'keep' | 'stop' = 'keep';
  private detachedTimer?: ReturnType<typeof setTimeout>;
  private readonly ports = new Map<string, Port>();
  private stopping?: Promise<void>;
  /** The log stays after exit unless a host stopped the keeper on purpose. */
  private keepLog = true;
  private readonly relay: AcpRelay;
  private readonly control: { [K in KeeperHostLine['keeper']]: ControlHandler<K> };

  constructor(private readonly config: KeeperConfig) {
    this.relay = new AcpRelay({
      toHost: (line) => this.writeHost(line),
      toAgent: (line) => {
        this.agent?.stdin?.write(`${line}\n`);
      },
    });
    this.control = {
      hello: () => undefined,
      reach: (line) => this.reach(line),
      launch: (line) => this.launch(line),
      stop: () => {
        // A host that closes its agent leaves nothing to look into later.
        this.keepLog = false;
        void this.stop();
      },
    };
  }

  log(message: string): void {
    try {
      appendFileSync(this.config.log, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Logging must never take the keeper down.
    }
  }

  //#region Hosts

  /** A connection: it must say hello with the token before anything else. */
  accept(socket: Socket): void {
    const splitter = new LineSplitter();
    let greeted = false;
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      for (const line of splitter.push(chunk)) {
        if (!greeted) {
          greeted = this.greet(socket, line);
          if (!greeted) {
            socket.destroy();
            return;
          }
          continue;
        }
        this.fromHost(line);
      }
    });
    socket.on('close', () => {
      if (greeted && this.host === socket) {
        this.hostGone();
      }
    });
  }

  private greet(socket: Socket, line: string): boolean {
    const parsed = KeeperHostLineSchema.safeParse(this.json(line));
    if (!parsed.success || parsed.data.keeper !== 'hello') {
      return false;
    }
    if (!sameSecret(parsed.data.token, this.config.token)) {
      this.log('refused a connection with the wrong token');
      return false;
    }
    // A host that reattaches while its old connection still looks open takes over.
    const previous = this.host;
    if (previous) {
      this.host = undefined;
      this.relay.detach();
      previous.destroy();
    }
    this.host = socket;
    this.whenHostExits = parsed.data.whenHostExits;
    clearTimeout(this.detachedTimer);
    this.send({
      keeper: 'welcome',
      agent: this.agent ? 'running' : 'none',
    });
    this.relay.attach();
    this.log('host attached');
    return true;
  }

  private fromHost(line: string): void {
    if (!isControlLine(line)) {
      this.relay.fromHost(line);
      return;
    }
    const parsed = KeeperHostLineSchema.safeParse(this.json(line));
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    const handler = frameworkCast<ControlHandler<typeof message.keeper>>(
      this.control[message.keeper],
    );
    void Promise.resolve(handler(message)).catch((error: unknown) => {
      if ('id' in message) {
        this.send({
          keeper: 'error',
          id: message.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private hostGone(): void {
    this.host = undefined;
    this.relay.detach();
    for (const port of this.ports.values()) {
      port.target = undefined;
    }
    if (!this.agent || this.whenHostExits === 'stop') {
      this.log('host gone; stopping');
      void this.stop();
      return;
    }
    this.log('host gone; keeping the agent');
    if (this.config.detachedTimeoutMs > 0) {
      this.detachedTimer = setTimeout(() => {
        this.log('no host reattached in time; stopping');
        void this.stop();
      }, this.config.detachedTimeoutMs);
    }
  }

  private send(line: KeeperLine): void {
    this.writeHost(JSON.stringify(line));
  }

  private writeHost(line: string): void {
    if (!this.host || this.host.destroyed) {
      return;
    }
    this.host.write(`${line}\n`);
  }

  private json(line: string): unknown {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  }

  //#endregion

  //#region Agent

  private async launch(
    line: Extract<
      KeeperHostLine,
      {
        keeper: 'launch';
      }
    >,
  ): Promise<void> {
    if (this.agent) {
      throw new Error('The keeper already runs an agent.');
    }
    const agent = spawn(line.command, line.args, {
      cwd: line.cwd,
      env: line.env,
      stdio: [
        'pipe',
        'pipe',
        'pipe',
      ],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      agent.once('spawn', resolve);
      agent.once('error', reject);
    });
    agent.on('error', () => undefined);
    agent.stdin?.on('error', () => undefined);
    this.agent = agent;
    const out = new LineSplitter();
    agent.stdout?.on('data', (chunk: Buffer) => {
      for (const agentLine of out.push(chunk)) {
        this.relay.fromAgent(agentLine);
      }
    });
    agent.stderr?.on('data', (chunk: Buffer) => this.stderr(chunk));
    agent.once('exit', (code, signal) => {
      this.log(`agent exited (${code ?? signal})`);
      this.agent = undefined;
      void this.stop();
    });
    this.send({
      keeper: 'launched',
      id: line.id,
    });
  }

  private stderr(chunk: Buffer): void {
    if (this.host) {
      this.send({
        keeper: 'stderr',
        data: chunk.toString('utf8'),
      });
      return;
    }
    this.log(`agent stderr: ${chunk.toString('utf8').trimEnd()}`);
  }

  /** Stop the agent's tree, release everything, and exit. Shared by every caller. */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    clearTimeout(this.detachedTimer);
    const agent = this.agent;
    this.agent = undefined;
    if (agent) {
      await stopProcessTree(agent).catch((error: unknown) => {
        this.log(`could not stop the agent: ${String(error)}`);
      });
    }
    for (const port of this.ports.values()) {
      for (const held of port.held) {
        held.res.writeHead(503).end();
      }
      port.server.close();
      port.server.closeAllConnections();
    }
    this.host?.end();
    if (!this.keepLog) {
      rmSync(this.config.log, {
        force: true,
      });
    }
    this.onStopped();
  }

  /** Set by {@link runKeeper}: release the socket and exit. */
  onStopped: () => void = () => undefined;

  //#endregion

  //#region Bridge port

  private async reach(
    line: Extract<
      KeeperHostLine,
      {
        keeper: 'reach';
      }
    >,
  ): Promise<void> {
    const existing = this.ports.get(line.path);
    const port = existing ?? (await this.openPort(line.path));
    port.target = new URL(line.target);
    this.send({
      keeper: 'reached',
      id: line.id,
      url: port.url,
    });
    const held = port.held.splice(0);
    for (const request of held) {
      this.forward(port, request);
    }
  }

  private async openPort(path: string): Promise<Port> {
    const held: HeldRequest[] = [];
    let port: Port | undefined;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (!port) {
          res.writeHead(503).end();
          return;
        }
        const request: HeldRequest = {
          req,
          res,
          body: Buffer.concat(chunks),
        };
        if (!port.target) {
          port.held.push(request);
          return;
        }
        this.forward(port, request);
      });
    });
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
    port = {
      server,
      url: `http://127.0.0.1:${address.port}${path}`,
      held,
    };
    this.ports.set(path, port);
    return port;
  }

  /**
   * Send one request to the host's bridge. A request that never reached it —
   * the host went away — waits for the next host's bridge instead of failing.
   */
  private forward(port: Port, request: HeldRequest): void {
    const target = port.target;
    if (!target) {
      port.held.push(request);
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.req.headers)) {
      if (value !== undefined && !HOP_HEADERS.has(name)) {
        headers[name] = value;
      }
    }
    const path = new URL(request.req.url ?? '/', target.origin);
    const outgoing = http.request(
      new URL(path.pathname + path.search, target.origin),
      {
        method: request.req.method,
        headers,
      },
      (response) => {
        request.res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(request.res);
      },
    );
    outgoing.on('error', (error: unknown) => {
      if (UNDELIVERED.has(errorCode(error) ?? '') && !request.res.headersSent) {
        if (port.target === target) {
          port.target = undefined;
        }
        port.held.push(request);
        return;
      }
      if (!request.res.headersSent) {
        request.res.writeHead(502);
      }
      request.res.end();
    });
    outgoing.end(request.body);
  }

  //#endregion
}

//#endregion

//#region Public API

/**
 * Run a keeper until its agent exits or it is stopped. Resolves once it
 * listens on `config.address`.
 */
export async function runKeeper(config: KeeperConfig): Promise<{
  stopped: Promise<void>;
}> {
  const keeper = new Keeper(config);
  const server = net.createServer((socket) => keeper.accept(socket));
  if (process.platform !== 'win32') {
    rmSync(config.address, {
      force: true,
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.address, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const stopped = new Promise<void>((resolve) => {
    keeper.onStopped = () => {
      server.close();
      if (process.platform !== 'win32') {
        rmSync(config.address, {
          force: true,
        });
      }
      resolve();
    };
  });
  keeper.log(`listening on ${config.address}`);
  return {
    stopped,
  };
}

//#endregion
