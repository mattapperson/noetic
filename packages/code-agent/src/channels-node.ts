import net from 'node:net';
import { z } from 'zod';
import type {
  ChannelTransportAdapter,
  ChannelTransportController,
  ChannelTransportFrame,
} from './channels.js';

export interface UnixSocketChannelTransportOptions {
  socketPath: string;
  role: 'server' | 'client';
}

function encodeFrame(frame: ChannelTransportFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

const ChannelTransportFrameSchema = z.object({
  channel: z.string(),
  value: z.unknown(),
});

function parseFrame(raw: string): ChannelTransportFrame | null {
  try {
    const parsed = ChannelTransportFrameSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function createUnixSocketChannelTransportAdapter(
  opts: UnixSocketChannelTransportOptions,
): ChannelTransportAdapter {
  const subscribers = new Set<(frame: ChannelTransportFrame) => void>();
  let controller: ChannelTransportController | null = null;
  let server: net.Server | null = null;
  const sockets = new Set<net.Socket>();

  function emit(frame: ChannelTransportFrame): void {
    controller?.receive(frame);
    for (const handler of subscribers) {
      handler(frame);
    }
  }

  function attachSocket(socket: net.Socket): void {
    sockets.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (raw.trim()) {
          const frame = parseFrame(raw);
          if (frame) {
            emit(frame);
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  }

  return {
    async start(nextController) {
      controller = nextController;
      if (opts.role !== 'server' || server) {
        return;
      }
      server = net.createServer(attachSocket);
      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(opts.socketPath, () => resolve());
      });
    },
    async stop() {
      controller = null;
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      if (server) {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
        server = null;
      }
    },
    async publish(frame) {
      if (opts.role === 'client') {
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(opts.socketPath, () => {
            socket.end(encodeFrame(frame));
          });
          socket.once('close', () => resolve());
          socket.once('error', reject);
        });
        return;
      }
      for (const socket of sockets) {
        socket.write(encodeFrame(frame));
      }
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
  };
}
