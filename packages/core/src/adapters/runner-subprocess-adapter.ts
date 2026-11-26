/**
 * The host's end of a remote runner (`noetic-acp serve`): a subprocess
 * adapter whose processes run where the runner runs and whose tool bridge is
 * reached through it.
 *
 * Platform-neutral: it needs only `fetch` and a {@link FrameLink}. The
 * platform packages open that link over a WebSocket or a command's stdio.
 */

import type {
  AcpReattachHandle,
  AcpTransport,
  AcpWhenHostExits,
  FrameLink,
  RunnerFrame,
  SpawnCommand,
  SubprocessAdapter,
  SubprocessLink,
  SubprocessOpen,
  ToolBridgeAddress,
} from '@noetic-tools/types';
import {
  AcpConnectError,
  chunksOf,
  fromBase64,
  NoeticConfigError,
  RunnerFrameSchema,
  toBase64,
} from '@noetic-tools/types';
import { createLinkSubprocessAdapter } from './link-subprocess-adapter';

//#region Types

interface Waiter {
  resolve(frame: RunnerFrame): void;
  reject(error: Error): void;
}

interface Stream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  exited: Promise<number | null>;
  exit(code: number | null): void;
}

/** A stream's host side, before the runner has answered for it. */
type OpenedStream = Pick<Stream, 'exited'> & {
  readable: ReadableStream<Uint8Array>;
};

/** How long a runner may take to answer a reattach. */
const ATTACH_TIMEOUT_MS = 1e4;
/** How long closing a stream waits for the runner to report it stopped. */
const KILL_WAIT_MS = 5e3;

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
 * A subprocess adapter whose processes run through a remote runner, reached
 * over the frame link `dial` opens: one link per `open`. It holds a
 * process's stdio (`open`) and runs `process` requests that carry no
 * `stdin`. The runner's frames carry no end of input, so a request with
 * `stdin` — a `runCode` node's — is refused rather than left waiting for
 * one, and a command given none finds its input open and empty. A runner has
 * no Noetic runtime, so a `step` request is refused too.
 *
 * @throws `NoeticConfigError` from `spawn`: `SUBPROCESS_RUNS_NO_STEPS` for a `step` request, `SUBPROCESS_CANNOT_END_INPUT` for a `process` request with `stdin`.
 * @public
 */
export function createRunnerSubprocessAdapter(
  dial: (signal?: AbortSignal) => Promise<FrameLink>,
): SubprocessAdapter & {
  open: SubprocessOpen;
} {
  const adapter = createLinkSubprocessAdapter(
    async ({ signal, whenHostExits = 'keep' }) => {
      const peer = new RunnerPeer(await dial(signal), signal);
      // Processes this channel launches run through a keeper beside the
      // runner, so they outlive the channel and a later one can reattach.
      peer.keep(whenHostExits);
      return peer.subprocessLink();
    },
    {
      runtime: 'runner',
    },
  );
  return {
    ...adapter,
    async spawn(request) {
      if (request.kind !== 'step' && request.stdin !== undefined) {
        throw new NoeticConfigError({
          code: 'SUBPROCESS_CANNOT_END_INPUT',
          message: `A remote runner cannot run '${request.command}' with \`stdin\`: its frames carry no end of input, so the command would wait for one and never finish.`,
          hint: 'Run it through an adapter on this machine (`createLocalSubprocessAdapter()` from @noetic-tools/platform-node), or give the command its input as an argument or a file.',
        });
      }
      return await adapter.spawn(request);
    },
  };
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

  subprocessLink(): SubprocessLink {
    return {
      reach: (bridge) => this.reach(bridge),
      launch: (command) => this.start(command, 'launch'),
      spawn: (command) => this.start(command, 'spawn'),
      attach: (handle) => this.attach(handle),
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

  keep(whenHostExits: AcpWhenHostExits): void {
    this.link.send({
      t: 'keep',
      id: this.id(),
      whenHostExits,
    });
  }

  /** The stream of an agent an earlier channel launched and the runner kept. */
  private async attach(handle: AcpReattachHandle): Promise<AcpTransport> {
    const id = this.id();
    const stream = this.openStream(id);
    // A runner that does not keep agents never answers an attach.
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new AcpConnectError({
              agentId: 'runner',
              message: 'The remote runner did not answer a reattach; it may not keep agents.',
            }),
          ),
        ATTACH_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    const reply = await Promise.race([
      this.ask(
        {
          t: 'attach',
          handle,
        },
        id,
      ),
      timeout,
    ]).catch((e: unknown) => {
      this.streams.delete(id);
      throw e;
    });
    if (reply.t !== 'started') {
      throw unexpected(reply);
    }
    return this.transportFor(id, stream, handle);
  }

  private async start(command: SpawnCommand, kind: 'launch' | 'spawn'): Promise<AcpTransport> {
    const id = this.id();
    const stream = this.openStream(id);
    const reply = await this.ask(
      {
        t: 'start',
        kind,
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
    return this.transportFor(id, stream, reply.reattach);
  }

  /** The readable for stream `id`, registered before the runner can answer. */
  private openStream(id: string): OpenedStream {
    let exit = (_code: number | null): void => undefined;
    const exited = new Promise<number | null>((resolve) => {
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
    return {
      readable,
      exited,
    };
  }

  /** Stream `id` as a transport; closing it stops what it carries. */
  private transportFor(
    id: string,
    stream: OpenedStream,
    reattach: AcpReattachHandle | undefined,
  ): AcpTransport {
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
      readable: stream.readable,
      writable,
      reattach,
      exited: stream.exited,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        // A process that has exited left nothing to stop.
        if (!this.streams.has(id)) {
          return;
        }
        this.link.send({
          t: 'kill',
          id,
        });
        await Promise.race([
          stream.exited,
          new Promise((resolve) => setTimeout(resolve, KILL_WAIT_MS)),
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
      this.ended(frame.id, frame.code);
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

  private ended(id: string, code: number | null): void {
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
    stream.exit(code);
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
      this.ended(id, null);
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
