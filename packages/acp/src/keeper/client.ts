/**
 * The host's side of a keeper (`process.ts`): start one for a new agent, or
 * attach to the one an earlier host left running, and carry the agent's ACP
 * stream and the bridge port over its socket.
 */

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AcpReattachHandle,
  AcpTransport,
  AcpWhenHostExits,
  SpawnCommand,
} from '@noetic-tools/types';
import { AcpConnectError } from '@noetic-tools/types';
import { z } from 'zod';
import type { KeeperConfig, KeeperHostLine, KeeperLine } from './protocol';
import { isControlLine, KeeperLineSchema, LineSplitter } from './protocol';

//#region Types

/** @public Options for starting a keeper. */
export interface KeeperStartOptions {
  whenHostExits: AcpWhenHostExits;
  /** How long the agent may run with no host attached; 0 = no limit. */
  detachedTimeoutMs: number;
}

interface Waiter {
  resolve(line: KeeperLine): void;
  reject(error: Error): void;
}

//#endregion

//#region Handle

const KeeperHandleSchema = z.object({
  kind: z.literal('noetic-acp-keeper'),
  version: z.literal(1),
  address: z.string(),
  token: z.string(),
});

/** @public What a keeper's reattach handle holds. */
export type KeeperHandle = z.infer<typeof KeeperHandleSchema>;

/** The keeper part of a reattach handle, or undefined when it names no keeper. */
export function keeperHandleOf(handle: AcpReattachHandle): KeeperHandle | undefined {
  const parsed = KeeperHandleSchema.safeParse(handle);
  return parsed.success ? parsed.data : undefined;
}

//#endregion

//#region Constants

/** How long a keeper may take to start listening. */
const START_TIMEOUT_MS = 1e4;
/** How long `stop` waits for the keeper to close its end. */
const STOP_WAIT_MS = 5e3;

//#endregion

//#region Helpers

/**
 * The keeper's entry script beside this module, or undefined when there is
 * none on disk (a bundled single-file build), in which case agents are
 * started directly and do not outlive their host.
 */
export function keeperScript(): string | undefined {
  for (const name of [
    './main.js',
    './main.ts',
  ]) {
    const url = new URL(name, import.meta.url);
    if (url.protocol !== 'file:') {
      continue;
    }
    const path = fileURLToPath(url);
    if (existsSync(path)) {
      return path;
    }
  }
  return undefined;
}

/** Where this user's keepers listen and log (POSIX). */
function keeperDirectory(): string {
  return join(tmpdir(), `noetic-acp-${process.getuid?.() ?? 'user'}`);
}

/** The prefix of every keeper's named pipe (Windows). */
const PIPE_PREFIX = '\\\\.\\pipe\\noetic-acp-';

/**
 * Whether `handle` names a keeper this user's keepers would listen on — so a
 * runner never connects to an arbitrary socket a host names.
 */
export function isKeeperAddress(address: string): boolean {
  if (process.platform === 'win32') {
    return address.startsWith(PIPE_PREFIX);
  }
  return (
    address.startsWith(`${keeperDirectory()}/`) &&
    !address.includes('..') &&
    address.endsWith('.sock')
  );
}

/** A fresh private address for a keeper, and its log file. */
function newAddress(): {
  address: string;
  log: string;
} {
  const id = randomBytes(6).toString('hex');
  if (process.platform === 'win32') {
    return {
      address: `${PIPE_PREFIX}${id}-${randomUUID()}`,
      log: join(tmpdir(), `noetic-acp-${id}.log`),
    };
  }
  // Only this user may open the directory, so only this user reaches the socket.
  const dir = keeperDirectory();
  mkdirSync(dir, {
    recursive: true,
    mode: 0o700,
  });
  chmodSync(dir, 0o700);
  return {
    address: join(dir, `${id}.sock`),
    log: join(dir, `${id}.log`),
  };
}

async function readFirstLine(stream: NodeJS.ReadableStream, ms: number): Promise<string> {
  const splitter = new LineSplitter();
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The keeper did not start in time.')), ms);
    stream.on('data', (chunk: Buffer) => {
      const [first] = splitter.push(chunk);
      if (first !== undefined) {
        clearTimeout(timer);
        resolve(first);
      }
    });
    stream.once('end', () => {
      clearTimeout(timer);
      reject(new Error('The keeper exited before it was ready.'));
    });
  });
}

function connectSocket(address: string): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(address);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[name] = value;
    }
  }
  return out;
}

//#endregion

//#region Keeper link

/**
 * One host's connection to a keeper. Control lines are answered here; every
 * other line is the agent's ACP stream.
 * @public
 */
export class KeeperLink {
  private next = 0;
  private readonly waiters = new Map<string, Waiter>();
  private readonly welcomed: Promise<'running' | 'none'>;
  private acp?: ReadableStreamDefaultController<Uint8Array>;
  /** ACP lines that arrived before the stream was taken. */
  private readonly early: Uint8Array[] = [];
  private readonly encoder = new TextEncoder();
  private closed = false;
  private stopping?: Promise<void>;
  /** Where the agent's stderr goes. Default: this process's stderr. */
  onStderr: (chunk: string) => void = (chunk) => {
    process.stderr.write(chunk);
  };

  constructor(
    private readonly socket: net.Socket,
    readonly handle: KeeperHandle,
    private readonly agentId: string,
  ) {
    let welcome: (agent: 'running' | 'none') => void = () => undefined;
    let refuse: (error: Error) => void = () => undefined;
    this.welcomed = new Promise((resolve, reject) => {
      welcome = resolve;
      refuse = reject;
    });
    const splitter = new LineSplitter();
    socket.on('data', (chunk: Buffer) => {
      for (const line of splitter.push(chunk)) {
        this.receive(line, welcome);
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.closed = true;
      refuse(this.lost('closed the connection before welcoming this host'));
      for (const waiter of this.waiters.values()) {
        waiter.reject(this.lost('closed the connection'));
      }
      this.waiters.clear();
      try {
        this.acp?.close();
      } catch {
        // Already closed.
      }
    });
  }

  /** Say hello; resolves with whether the keeper runs an agent. */
  async hello(whenHostExits: AcpWhenHostExits): Promise<'running' | 'none'> {
    this.write({
      keeper: 'hello',
      token: this.handle.token,
      whenHostExits,
    });
    return await this.welcomed;
  }

  /** Serve the bridge at `target` on the keeper's port for `path`. */
  async reach(path: string, target: string): Promise<string> {
    const reply = await this.ask({
      keeper: 'reach',
      id: this.id(),
      path,
      target,
    });
    if (reply.keeper !== 'reached') {
      throw this.lost(`answered a reach with '${reply.keeper}'`);
    }
    return reply.url;
  }

  /** Start the agent and return its stream. */
  async launch(command: SpawnCommand): Promise<AcpTransport> {
    const reply = await this.ask({
      keeper: 'launch',
      id: this.id(),
      command: command.command,
      args: [
        ...(command.args ?? []),
      ],
      env: definedEnv(command.env ?? {}),
      cwd: command.cwd,
    });
    if (reply.keeper !== 'launched') {
      throw this.lost(`answered a launch with '${reply.keeper}'`);
    }
    return this.transport();
  }

  /** The stream of the agent the keeper already runs. */
  transport(): AcpTransport {
    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.acp = controller;
        for (const chunk of this.early.splice(0)) {
          controller.enqueue(chunk);
        }
        if (this.closed) {
          controller.close();
        }
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (!this.closed) {
          this.socket.write(chunk);
        }
      },
    });
    return {
      readable,
      writable,
      reattach: this.handle,
      close: () => this.stop(),
      detach: () => this.release(),
    };
  }

  /** Stop the agent's tree and the keeper. Shared by every caller. */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  /** Let go of the keeper without stopping it, as a host that goes away does. */
  detach(): void {
    this.socket.destroy();
  }

  /**
   * Let go of an agent this host did not adopt: the keeper keeps it running
   * whatever exit policy this host's hello set, then the connection drops.
   */
  async release(): Promise<void> {
    if (this.closed) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.socket.write(
        `${JSON.stringify({
          keeper: 'release',
        })}\n`,
        () => resolve(),
      );
    });
    this.socket.destroy();
  }

  private async shutdown(): Promise<void> {
    // A socket this host already dropped (`detach`, `release`) has let go of
    // the agent: there is no one left to tell to stop.
    if (this.closed || this.socket.destroyed) {
      return;
    }
    this.write({
      keeper: 'stop',
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STOP_WAIT_MS);
      timer.unref?.();
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.socket.destroy();
  }

  private receive(line: string, welcome: (agent: 'running' | 'none') => void): void {
    if (!isControlLine(line)) {
      const bytes = this.encoder.encode(`${line}\n`);
      if (this.acp) {
        this.acp.enqueue(bytes);
      } else {
        this.early.push(bytes);
      }
      return;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = KeeperLineSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.keeper === 'welcome') {
      welcome(message.agent);
      return;
    }
    if (message.keeper === 'stderr') {
      this.onStderr(message.data);
      return;
    }
    const waiter = this.waiters.get(message.id);
    if (!waiter) {
      return;
    }
    this.waiters.delete(message.id);
    if (message.keeper === 'error') {
      waiter.reject(this.lost(`refused: ${message.message}`));
      return;
    }
    waiter.resolve(message);
  }

  private ask(
    line: KeeperHostLine & {
      id: string;
    },
  ): Promise<KeeperLine> {
    if (this.closed) {
      return Promise.reject(this.lost('closed the connection'));
    }
    return new Promise<KeeperLine>((resolve, reject) => {
      this.waiters.set(line.id, {
        resolve,
        reject,
      });
      this.write(line);
    });
  }

  private write(line: KeeperHostLine): void {
    if (!this.closed) {
      this.socket.write(`${JSON.stringify(line)}\n`);
    }
  }

  private id(): string {
    this.next += 1;
    return `k${this.next}`;
  }

  private lost(what: string): AcpConnectError {
    return new AcpConnectError({
      agentId: this.agentId,
      message: `The keeper of ACP agent '${this.agentId}' ${what}.`,
    });
  }
}

//#endregion

//#region Public API

/**
 * Start a keeper and connect to it, or return undefined when there is no
 * keeper script to run.
 */
export async function startKeeper(
  agentId: string,
  opts: KeeperStartOptions,
): Promise<KeeperLink | undefined> {
  const script = keeperScript();
  if (!script) {
    return undefined;
  }
  const { address, log } = newAddress();
  const handle: KeeperHandle = {
    kind: 'noetic-acp-keeper',
    version: 1,
    address,
    token: `${randomUUID()}${randomUUID()}`,
  };
  const config: KeeperConfig = {
    address,
    token: handle.token,
    log,
    detachedTimeoutMs: opts.detachedTimeoutMs,
  };
  // Its own process group and session: the host's Ctrl-C or crash does not
  // reach it, so it can keep the agent for the next host.
  const child = spawn(
    process.execPath,
    [
      script,
    ],
    {
      detached: true,
      stdio: [
        'pipe',
        'pipe',
        'ignore',
      ],
      windowsHide: true,
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.stdin?.end(`${JSON.stringify(config)}\n`);
    const ready = child.stdout ? await readFirstLine(child.stdout, START_TIMEOUT_MS) : '';
    if (!ready.includes('"ready"')) {
      throw new Error('The keeper did not say it was ready.');
    }
  } catch (cause) {
    child.kill();
    throw new AcpConnectError({
      agentId,
      message: `The keeper for ACP agent '${agentId}' failed to start.`,
      cause,
    });
  }
  child.stdout?.destroy();
  child.unref();
  const link = new KeeperLink(await connectSocket(address), handle, agentId);
  await link.hello(opts.whenHostExits);
  return link;
}

/** Whether a failed connect means no keeper is there: its socket is missing or refuses. */
export function keeperIsGone(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) {
    return false;
  }
  const code = Reflect.get(cause, 'code');
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

/**
 * Connect to the keeper `handle` names. Rejects with AcpConnectError when it
 * is gone or no longer runs its agent.
 */
export async function attachKeeper(
  agentId: string,
  handle: KeeperHandle,
  whenHostExits: AcpWhenHostExits,
): Promise<KeeperLink> {
  let socket: net.Socket;
  try {
    socket = await connectSocket(handle.address);
  } catch (cause) {
    throw new AcpConnectError({
      agentId,
      message: `ACP agent '${agentId}' is no longer running: its keeper cannot be reached.`,
      cause,
      // No socket, or nobody listening on it: the keeper is gone. Any other
      // failure (permissions, a full table) says nothing about the agent.
      gone: keeperIsGone(cause),
    });
  }
  const link = new KeeperLink(socket, handle, agentId);
  const agent = await link.hello(whenHostExits);
  if (agent !== 'running') {
    await link.stop();
    throw new AcpConnectError({
      agentId,
      message: `ACP agent '${agentId}' is no longer running.`,
      gone: true,
    });
  }
  return link;
}

//#endregion
