/**
 * The frames between a host and a remote runner (`noetic-acp serve`), carried
 * as JSON over one WebSocket or one stdio pipe.
 *
 * The one channel carries everything a connection needs where the agent
 * runs: processes the host starts there (the agent, and MCP servers beside
 * it), their stdio, and the tool bridge — HTTP requests the agent sends to a
 * loopback port beside it, answered by the host's bridge.
 */

import { z } from 'zod';

//#region Frames

const Id = z.string().min(1);
const Bytes = z.string();
const Headers = z.array(
  z.tuple([
    z.string(),
    z.string(),
  ]),
);

/** @public Host → runner. */
export const HostFrameSchema = z.discriminatedUnion('t', [
  /** Open a loopback port that forwards to the host's bridge. */
  z.object({
    t: z.literal('reach'),
    id: Id,
    path: z.string().startsWith('/'),
  }),
  /**
   * Start a process; its stdio becomes stream `id`. `launch` is the agent,
   * `spawn` an MCP server beside it (`SubprocessLink.launch` and `.spawn`).
   */
  z.object({
    t: z.literal('start'),
    id: Id,
    kind: z.enum([
      'launch',
      'spawn',
    ]),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    cwd: z.string().optional(),
  }),
  z.object({
    t: z.literal('stdin'),
    id: Id,
    data: Bytes,
  }),
  z.object({
    t: z.literal('kill'),
    id: Id,
  }),
  /**
   * Run the agents this channel launches through a keeper beside the
   * runner, so they outlive the channel; `whenHostExits` says what happens
   * to them when it drops. Sent once, first, by hosts that keep agents.
   */
  z.object({
    t: z.literal('keep'),
    id: Id,
    whenHostExits: z.enum([
      'keep',
      'stop',
    ]),
  }),
  /**
   * Carry the stream of an agent an earlier channel launched, from the
   * reattach handle its `started` frame gave; answered with `started`.
   */
  z.object({
    t: z.literal('attach'),
    id: Id,
    handle: z.record(z.string(), z.unknown()),
  }),
  z.object({
    t: z.literal('response'),
    id: Id,
    status: z.number().int(),
    headers: Headers,
  }),
  z.object({
    t: z.literal('body'),
    id: Id,
    data: Bytes,
  }),
  z.object({
    t: z.literal('end'),
    id: Id,
  }),
]);

/** @public Runner → host. */
export const RunnerFrameSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('reached'),
    id: Id,
    url: z.string().url(),
  }),
  z.object({
    t: z.literal('started'),
    id: Id,
    /** For a kept agent: how a later channel reaches it again. */
    reattach: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    t: z.literal('stdout'),
    id: Id,
    data: Bytes,
  }),
  z.object({
    t: z.literal('exit'),
    id: Id,
    code: z.number().int().nullable(),
  }),
  /** A request or start the runner could not carry out. */
  z.object({
    t: z.literal('error'),
    id: Id,
    message: z.string(),
  }),
  /** An HTTP request the agent sent to a reached port. */
  z.object({
    t: z.literal('request'),
    id: Id,
    method: z.string(),
    path: z.string(),
    headers: Headers,
    body: Bytes,
  }),
  /** The agent dropped a request before its response ended. */
  z.object({
    t: z.literal('abort'),
    id: Id,
  }),
]);

/** @public */
export type HostFrame = z.infer<typeof HostFrameSchema>;
/** @public */
export type RunnerFrame = z.infer<typeof RunnerFrameSchema>;

//#endregion

//#region Link

/**
 * One duplex channel of JSON frames: a WebSocket, or newline-delimited JSON
 * over a pipe.
 * @public
 */
export interface FrameLink {
  send(frame: unknown): void;
  /** Each frame as it arrives, parsed but not yet checked. */
  onFrame(listener: (frame: unknown) => void): void;
  onClose(listener: (reason?: Error) => void): void;
  close(): Promise<void>;
}

/**
 * Frames over a byte stream, one JSON object per line.
 * @public
 */
export function lineFrameLink(
  readable: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
  close: () => Promise<void>,
): FrameLink {
  const frameListeners: Array<(frame: unknown) => void> = [];
  const closeListeners: Array<(reason?: Error) => void> = [];
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let closed = false;
  const finish = (reason?: Error): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const listener of closeListeners) {
      listener(reason);
    }
  };
  void readLines(readable, (line) => {
    const frame = parseLine(line);
    if (frame === undefined) {
      return;
    }
    for (const listener of frameListeners) {
      listener(frame);
    }
  }).then(
    () => finish(),
    (e: unknown) => finish(e instanceof Error ? e : new Error(String(e))),
  );
  return {
    send(frame) {
      if (closed) {
        return;
      }
      writer.write(encoder.encode(`${JSON.stringify(frame)}\n`)).catch(() => finish());
    },
    onFrame: (listener) => {
      frameListeners.push(listener);
    },
    onClose: (listener) => {
      closeListeners.push(listener);
    },
    async close() {
      finish();
      await writer.close().catch(() => undefined);
      await close();
    },
  };
}

/**
 * The part of a WebSocket a {@link FrameLink} uses. A browser's, a Worker's
 * and the `ws` package's sockets all fit.
 * @public
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: (event: { error?: unknown }) => void): void;
}

/** `WebSocket.OPEN` and `WebSocket.CLOSED`, which a {@link WebSocketLike} need not name. */
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

/**
 * Frames over an open WebSocket, one JSON object per text message.
 * @public
 */
export function webSocketFrameLink(socket: WebSocketLike): FrameLink {
  const closeListeners: Array<(reason?: Error) => void> = [];
  let failure: Error | undefined;
  socket.addEventListener('error', (event) => {
    failure = event.error instanceof Error ? event.error : new Error('The WebSocket failed.');
  });
  socket.addEventListener('close', () => {
    for (const listener of closeListeners) {
      listener(failure);
    }
  });
  return {
    send(frame) {
      if (socket.readyState === SOCKET_OPEN) {
        socket.send(JSON.stringify(frame));
      }
    },
    onFrame(listener) {
      socket.addEventListener('message', (event) => {
        const frame = typeof event.data === 'string' ? parseLine(event.data) : undefined;
        if (frame !== undefined) {
          listener(frame);
        }
      });
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    async close() {
      if (socket.readyState === SOCKET_CLOSED) {
        return;
      }
      await new Promise<void>((resolve) => {
        socket.addEventListener('close', () => resolve());
        socket.close();
      });
    },
  };
}

async function readLines(
  readable: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of chunksOf(readable)) {
    buffered += decoder.decode(chunk, {
      stream: true,
    });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      onLine(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
  }
}

/**
 * The chunks of a byte stream, without relying on its async iterator.
 * @public
 */
export async function* chunksOf(readable: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseLine(line: string): unknown {
  if (line.trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

//#endregion

//#region Bytes

/** @public A frame's bytes, as the base64 text it carries them in. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** @public The bytes a frame carries as base64 text. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Hosts that never leave the machine, so a hop to them needs no TLS.
 * @public
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

//#endregion
