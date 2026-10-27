/**
 * A `send` frame carries its delivery mode through to `harness.execute`, so an
 * IPC client can steer a running turn rather than queue the next one.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import path from 'node:path';
import type {
  AgentHarness,
  DeliveryMode,
  HarnessStatus,
  StreamEvent,
  StreamingItem,
} from '@noetic-tools/core';
import { AgentIpcClient } from '../src/agent-ipc-client';
import type { IpcHarness } from '../src/agent-ipc-server';
import { AgentIpcServer } from '../src/agent-ipc-server';
import { createLocalFsAdapter } from '../src/local-fs-adapter';

//#region Helpers

interface ExecuteCall {
  input: string;
  messageId?: string;
  deliveryMode?: DeliveryMode;
}

async function* emptyStream<T>(): AsyncIterable<T> {}

/** Compile-time pin: the real harness can be served. Never called. */
export function harnessSatisfiesIpcHarness(harness: AgentHarness): IpcHarness {
  return harness;
}

function makeRecordingHarness(calls: ExecuteCall[]): IpcHarness {
  const status: HarnessStatus = {
    kind: 'idle',
  };
  return {
    async execute(input, options) {
      calls.push({
        input,
        messageId: options?.messageId,
        deliveryMode: options?.deliveryMode,
      });
    },
    getItemStream: () => emptyStream<StreamingItem>(),
    getFullStream: () => emptyStream<StreamEvent>(),
    getStatus: () => status,
    abort: async () => {},
  };
}

//#endregion

describe('AgentIpcServer send', () => {
  // Unix-domain socket paths max out near 104 bytes on macOS, so use /tmp.
  const socketPath = path.join(
    '/tmp',
    `n-ipc-send-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
  let server: AgentIpcServer | undefined;
  let client: AgentIpcClient | undefined;

  afterEach(async () => {
    // Server first: closing the client first leaves the server-side socket
    // half-open, and server.close() then waits on it.
    await server?.close('test-end');
    client?.close();
    rmSync(socketPath, {
      force: true,
    });
  });

  it('passes deliveryMode to harness.execute, and leaves it unset when omitted', async () => {
    const calls: ExecuteCall[] = [];
    server = new AgentIpcServer({
      harness: makeRecordingHarness(calls),
      chatHistoryStore: {
        readChatHistory: async () => [],
        appendChatItem: async () => {},
      },
      logger: async () => {},
      taskId: 'T-send',
      role: 'planner',
      runnerId: 'planner',
      threadId: 'thread-1',
      socketPath,
      askUserService: {
        peek: () => null,
        handleResolve: () => {},
        handleCancel: () => {},
        cancelAll: () => {},
      },
      fs: createLocalFsAdapter(),
    });
    await server.listen();
    client = new AgentIpcClient({
      socketPath,
    });
    await client.connect();

    await client.send({
      messageId: 'm-1',
      text: 'change course',
      deliveryMode: 'next-item',
    });
    await client.send({
      messageId: 'm-2',
      text: 'later',
    });

    expect(calls).toEqual([
      {
        input: 'change course',
        messageId: 'm-1',
        deliveryMode: 'next-item',
      },
      {
        input: 'later',
        messageId: 'm-2',
        deliveryMode: undefined,
      },
    ]);
  });
});
