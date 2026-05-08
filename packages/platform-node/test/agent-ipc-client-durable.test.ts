/**
 * AgentIpcClient durable-outbound handling — verifies wire-level
 * behaviour without needing a real server. We connect the client to a
 * unix-domain socket served by `node:net` inside the test, feed frames
 * in, and assert the client's exposed watermarks and delivery behaviour.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentIpcClient } from '../src/agent-ipc-client';
import { encodeFrame, type ServerFrame } from '../src/agent-ipc-protocol';

let root: string;
let server: Server;
let socketPath: string;
let clientSocket: Socket | null;

async function listen(): Promise<void> {
  return new Promise<void>((resolve) => {
    server = createServer();
    server.listen(socketPath, () => resolve());
  });
}

async function closeServer(): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function sendFrame(frame: ServerFrame): void {
  clientSocket?.write(encodeFrame(frame));
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'noetic-ipc-durable-'));
  socketPath = path.join(root, 'sock');
  clientSocket = null;
  server = createServer();
  await listen();
});

afterEach(async () => {
  clientSocket?.destroy();
  await closeServer();
  rmSync(root, {
    recursive: true,
    force: true,
  });
});

describe('AgentIpcClient durable frame handling', () => {
  it('unwraps durable frames and routes the inner payload to subscription streams', async () => {
    server.on('connection', (sock) => {
      clientSocket = sock;
      sock.write(
        encodeFrame({
          type: 'hello',
          protocolVersion: 2,
          taskId: 't-1',
          role: 'planner',
          runnerId: 'r-1',
          threadId: 'thread-1',
        }),
      );
    });
    const client = new AgentIpcClient({
      socketPath,
    });
    await client.connect();
    const { items } = client.subscribe();

    // Pump a durable-wrapped item frame.
    sendFrame({
      type: 'durable',
      seq: 1,
      frame: {
        type: 'item',
        item: {
          id: 'x-1',
          type: 'message',
        },
      },
    });

    // Grab one from the async iterable.
    let delivered: unknown = null;
    for await (const item of items) {
      delivered = item;
      break;
    }
    expect(delivered).not.toBeNull();
    expect(client.getHighestDeliveredDurableSeq()).toBe(1);

    client.close();
  });

  it('dedupes replay frames at or below the highest delivered durable seq', async () => {
    server.on('connection', (sock) => {
      clientSocket = sock;
      sock.write(
        encodeFrame({
          type: 'hello',
          protocolVersion: 2,
          taskId: 't',
          role: 'p',
          runnerId: 'r',
          threadId: 't',
        }),
      );
    });
    const client = new AgentIpcClient({
      socketPath,
    });
    await client.connect();
    const { items } = client.subscribe();

    sendFrame({
      type: 'durable',
      seq: 1,
      frame: {
        type: 'item',
        item: {
          n: 1,
        },
      },
    });
    sendFrame({
      type: 'durable',
      seq: 2,
      frame: {
        type: 'item',
        item: {
          n: 2,
        },
      },
    });
    // Replay of seq=1 after the client already delivered through seq=2.
    sendFrame({
      type: 'durable',
      seq: 1,
      frame: {
        type: 'item',
        item: {
          n: 'dup',
        },
      },
    });
    sendFrame({
      type: 'durable',
      seq: 3,
      frame: {
        type: 'item',
        item: {
          n: 3,
        },
      },
    });

    const received: unknown[] = [];
    const iter = items[Symbol.asyncIterator]();
    for (let i = 0; i < 3; i++) {
      const { value, done } = await iter.next();
      if (done) {
        break;
      }
      received.push(value);
    }
    expect(received.length).toBe(3);
    expect(client.getHighestDeliveredDurableSeq()).toBe(3);

    client.close();
  });

  it('sendDurableResume emits the watermark even when no frames have been delivered', async () => {
    const received: string[] = [];
    server.on('connection', (sock) => {
      clientSocket = sock;
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => {
        received.push(chunk);
      });
      sock.write(
        encodeFrame({
          type: 'hello',
          protocolVersion: 2,
          taskId: 't',
          role: 'p',
          runnerId: 'r',
          threadId: 't',
        }),
      );
    });
    const client = new AgentIpcClient({
      socketPath,
    });
    await client.connect();
    client.sendDurableResume();
    // Give the socket a tick to flush.
    await new Promise((r) => setTimeout(r, 5e1));
    const joined = received.join('');
    expect(joined).toContain('"type":"durableResume"');
    expect(joined).toContain('"ackedThrough":0');

    client.close();
  });

  it('acknowledgeDurableFrames emits a durableAck frame and is idempotent', async () => {
    const received: string[] = [];
    server.on('connection', (sock) => {
      clientSocket = sock;
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => {
        received.push(chunk);
      });
      sock.write(
        encodeFrame({
          type: 'hello',
          protocolVersion: 2,
          taskId: 't',
          role: 'p',
          runnerId: 'r',
          threadId: 't',
        }),
      );
    });
    const client = new AgentIpcClient({
      socketPath,
    });
    await client.connect();

    client.acknowledgeDurableFrames(5);
    client.acknowledgeDurableFrames(3); // Below watermark — should be a no-op.
    client.acknowledgeDurableFrames(5); // At watermark — should be a no-op.
    client.acknowledgeDurableFrames(9); // Above — should emit.

    await new Promise((r) => setTimeout(r, 5e1));
    const joined = received.join('');
    // Two distinct acks: 5 and 9.
    const ackCount = joined.match(/"type":"durableAck"/g)?.length ?? 0;
    expect(ackCount).toBe(2);
    expect(joined).toContain('"throughSeq":5');
    expect(joined).toContain('"throughSeq":9');
    expect(client.getLastAckedDurableSeq()).toBe(9);

    client.close();
  });
});
