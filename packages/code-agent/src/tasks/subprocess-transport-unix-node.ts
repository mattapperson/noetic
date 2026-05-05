import net from 'node:net';

import type { FsAdapter } from '@noetic/core';

import { dirname } from './path-utils.js';
import type {
  TaskRunTransportAdapter,
  TaskRunTransportFrame,
} from './subprocess-transport-memory.js';

export interface UnixTaskRunTransportOptions {
  socketPath: string;
  role: 'server' | 'client';
  /**
   * FsAdapter used to prepare the socket directory (mkdir) and clear a
   * stale socket (rm) before listening. Defaulting to `@noetic/core`'s
   * local adapter would pull it into every consumer's bundle; callers
   * pass their own.
   */
  fs: FsAdapter;
}

function encode(frame: TaskRunTransportFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

function parse(raw: string): TaskRunTransportFrame | null {
  try {
    const value = JSON.parse(raw) as Partial<TaskRunTransportFrame>;
    if (typeof value.runId !== 'string' || typeof value.type !== 'string') {
      return null;
    }
    return {
      runId: value.runId,
      type: value.type,
      payload: value.payload,
    };
  } catch {
    return null;
  }
}

export function createUnixSocketTaskRunTransportNode(
  options: UnixTaskRunTransportOptions,
): TaskRunTransportAdapter {
  const subscribers = new Map<string, Set<(frame: TaskRunTransportFrame) => void>>();
  const frames = new Map<string, TaskRunTransportFrame[]>();
  const sockets = new Set<net.Socket>();
  let server: net.Server | null = null;

  function emit(frame: TaskRunTransportFrame): void {
    const history = frames.get(frame.runId) ?? [];
    history.push(frame);
    frames.set(frame.runId, history);
    for (const handler of subscribers.get(frame.runId) ?? []) {
      handler(frame);
    }
  }

  function attach(socket: net.Socket): void {
    sockets.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = parse(raw);
        if (frame) {
          emit(frame);
        }
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  }

  async function ensureServer(): Promise<void> {
    if (options.role !== 'server' || server) {
      return;
    }
    await options.fs.mkdir(dirname(options.socketPath));
    await options.fs.rm(options.socketPath, {
      force: true,
    });
    server = net.createServer(attach);
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(options.socketPath, resolve);
    });
  }

  return {
    async publish(frame) {
      if (options.role === 'server') {
        await ensureServer();
        for (const socket of sockets) {
          socket.write(encode(frame));
        }
        emit(frame);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(options.socketPath, () => {
          socket.end(encode(frame));
        });
        socket.once('close', resolve);
        socket.once('error', reject);
      });
    },
    subscribe(runId, handler) {
      let set = subscribers.get(runId);
      if (!set) {
        set = new Set();
        subscribers.set(runId, set);
      }
      set.add(handler);
      if (options.role === 'server') {
        void ensureServer();
      }
      return () => {
        set?.delete(handler);
      };
    },
    async history(runId) {
      return [...(frames.get(runId) ?? [])];
    },
    async stop() {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      if (server) {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
        server = null;
      }
    },
  };
}
