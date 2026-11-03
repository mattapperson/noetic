/**
 * The host's end of a remote runner: an {@link AcpMachine} whose processes run
 * on the runner's machine and whose tool bridge is reached through it.
 *
 * Runtime-neutral: it needs only `fetch` and a {@link FrameLink}, so the
 * WebSocket and stdio links that open one live in the node entry.
 */

import type {
  AcpMachine,
  AcpMachineFactory,
  AcpTransport,
  SpawnCommand,
  ToolBridgeAddress,
} from '@noetic-tools/types';
import { AcpConnectError } from '@noetic-tools/types';
import type { FrameLink, RunnerFrame } from './protocol';
import { chunksOf, fromBase64, RunnerFrameSchema, toBase64 } from './protocol';

//#region Types

interface Waiter {
  resolve(frame: RunnerFrame): void;
  reject(error: Error): void;
}

interface Stream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  exited: Promise<void>;
  exit(): void;
}

/** Request headers that belong to one hop, which `fetch` sets for itself. */
const HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
]);

//#endregion

//#region Public API

/**
 * A machine reached through a remote runner over `openLink`.
 * @public
 */
export function runnerMachine(
  openLink: (signal?: AbortSignal) => Promise<FrameLink>,
): AcpMachineFactory {
  return async ({ signal }) => new RunnerPeer(await openLink(signal), signal).machine();
}

//#endregion

//#region Peer

class RunnerPeer {
  private next = 0;
  private readonly waiters = new Map<string, Waiter>();
  private readonly streams = new Map<string, Stream>();
  /** Reached bridge paths, to the host origin each forwards to. */
  private readonly bridges = new Map<string, string>();
  private readonly requests = new Map<string, AbortController>();
  private lost: Error | undefined;

  constructor(
    private readonly link: FrameLink,
    signal: AbortSignal | undefined,
  ) {
    link.onFrame((raw) => this.receive(raw));
    link.onClose((reason) => this.drop(reason ?? new Error('The runner closed the connection.')));
    signal?.addEventListener(
      'abort',
      () => {
        void link.close();
      },
      {
        once: true,
      },
    );
  }

  machine(): AcpMachine {
    return {
      reach: (bridge) => this.reach(bridge),
      launch: (command) => this.start(command),
      spawn: (command) => this.start(command),
      close: () => this.link.close(),
    };
  }

  private async reach(bridge: ToolBridgeAddress): Promise<ToolBridgeAddress> {
    const local = new URL(bridge.url);
    this.bridges.set(local.pathname, local.origin);
    const reply = await this.ask({
      t: 'reach',
      path: local.pathname,
    });
    if (reply.t !== 'reached') {
      throw unexpected(reply);
    }
    return {
      ...bridge,
      url: reply.url,
    };
  }

  private async start(command: SpawnCommand): Promise<AcpTransport> {
    const id = this.id();
    let exit = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.streams.set(id, {
          controller,
          exited,
          exit,
        });
      },
    });
    const reply = await this.ask(
      {
        t: 'start',
        command: command.command,
        args: [
          ...(command.args ?? []),
        ],
        env: definedEnv(command.env),
        cwd: command.cwd,
      },
      id,
    ).catch((e: unknown) => {
      this.streams.delete(id);
      throw e;
    });
    if (reply.t !== 'started') {
      throw unexpected(reply);
    }
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.link.send({
          t: 'stdin',
          id,
          data: toBase64(chunk),
        });
      },
    });
    let closed = false;
    return {
      readable,
      writable,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        this.link.send({
          t: 'kill',
          id,
        });
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 2e3)),
        ]);
      },
    };
  }

  private ask(frame: Record<string, unknown>, id = this.id()): Promise<RunnerFrame> {
    if (this.lost) {
      return Promise.reject(this.lost);
    }
    return new Promise<RunnerFrame>((resolve, reject) => {
      this.waiters.set(id, {
        resolve,
        reject,
      });
      this.link.send({
        ...frame,
        id,
      });
    });
  }

  private id(): string {
    this.next += 1;
    return `h${this.next}`;
  }

  //#region Incoming

  private receive(raw: unknown): void {
    const parsed = RunnerFrameSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const frame = parsed.data;
    if (frame.t === 'stdout') {
      this.streams.get(frame.id)?.controller.enqueue(fromBase64(frame.data));
      return;
    }
    if (frame.t === 'exit') {
      this.ended(frame.id);
      return;
    }
    if (frame.t === 'request') {
      void this.forward(frame);
      return;
    }
    if (frame.t === 'abort') {
      this.requests.get(frame.id)?.abort();
      return;
    }
    this.answer(frame);
  }

  private answer(frame: RunnerFrame): void {
    const waiter = this.waiters.get(frame.id);
    if (!waiter) {
      return;
    }
    this.waiters.delete(frame.id);
    if (frame.t === 'error') {
      waiter.reject(
        new AcpConnectError({
          agentId: 'runner',
          message: `The remote runner refused: ${frame.message}`,
        }),
      );
      return;
    }
    waiter.resolve(frame);
  }

  private ended(id: string): void {
    const stream = this.streams.get(id);
    if (!stream) {
      return;
    }
    this.streams.delete(id);
    try {
      stream.controller.close();
    } catch {
      // Already errored or closed.
    }
    stream.exit();
  }

  /** Answer a request the agent sent to a reached port from the host's bridge. */
  private async forward(
    frame: Extract<
      RunnerFrame,
      {
        t: 'request';
      }
    >,
  ): Promise<void> {
    const target = bridgeTarget(this.bridges, frame.path);
    if (!target) {
      this.respond(frame.id, 404, []);
      return;
    }
    const abort = new AbortController();
    this.requests.set(frame.id, abort);
    try {
      const body = frame.body === '' ? undefined : fromBase64(frame.body);
      const response = await fetch(target, {
        method: frame.method,
        headers: frame.headers.filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())),
        body,
        signal: abort.signal,
      });
      this.link.send({
        t: 'response',
        id: frame.id,
        status: response.status,
        headers: headerPairs(response.headers),
      });
      if (response.body) {
        for await (const chunk of chunksOf(response.body)) {
          this.link.send({
            t: 'body',
            id: frame.id,
            data: toBase64(chunk),
          });
        }
      }
      this.link.send({
        t: 'end',
        id: frame.id,
      });
    } catch {
      this.respond(frame.id, 502, []);
    } finally {
      this.requests.delete(frame.id);
    }
  }

  private respond(
    id: string,
    status: number,
    headers: Array<
      [
        string,
        string,
      ]
    >,
  ): void {
    this.link.send({
      t: 'response',
      id,
      status,
      headers,
    });
    this.link.send({
      t: 'end',
      id,
    });
  }

  private drop(reason: Error): void {
    this.lost = reason;
    for (const waiter of this.waiters.values()) {
      waiter.reject(reason);
    }
    this.waiters.clear();
    for (const id of [
      ...this.streams.keys(),
    ]) {
      this.ended(id);
    }
    for (const request of this.requests.values()) {
      request.abort();
    }
  }

  //#endregion
}

//#endregion

//#region Helpers

/**
 * The bridge URL a request path forwards to, or none. The URL is built from
 * the parsed path, the one that was checked: a raw path such as
 * `0/../mcp/x` parses to a bridge path but, appended to the origin, would
 * name another port.
 */
export function bridgeTarget(bridges: ReadonlyMap<string, string>, path: string): URL | undefined {
  const parsed = new URL(path, 'http://runner');
  const origin = bridges.get(parsed.pathname);
  if (!origin) {
    return undefined;
  }
  const target = new URL(parsed.pathname + parsed.search, origin);
  return target.origin === origin ? target : undefined;
}

function headerPairs(headers: Headers): Array<
  [
    string,
    string,
  ]
> {
  const pairs: Array<
    [
      string,
      string,
    ]
  > = [];
  headers.forEach((value, name) => {
    pairs.push([
      name,
      value,
    ]);
  });
  return pairs;
}

function definedEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value !== undefined) {
      out[name] = value;
    }
  }
  return out;
}

function unexpected(frame: RunnerFrame): Error {
  return new AcpConnectError({
    agentId: 'runner',
    message: `The remote runner answered with an unexpected '${frame.t}' frame.`,
  });
}

//#endregion
