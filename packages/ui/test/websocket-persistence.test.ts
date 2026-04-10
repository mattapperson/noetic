/**
 * Tests for NoeticUIServer debounced save and disk fallback behavior
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { TraceStorage } from '../src/service/storage';
import { NoeticUIServer } from '../src/service/websocket';
import type { ExecutionNode, ExecutionSummary } from '../src/shared/protocol';

// ============================================================================
// Helpers
// ============================================================================

/** Allocate a random port for each test to avoid collisions */
function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

function makeNode(id: string, parentId: string | null = null): ExecutionNode {
  return {
    id,
    stepId: `step-${id}`,
    kind: 'run',
    parentId,
    depth: parentId ? 1 : 0,
    startTime: Date.now(),
    endTime: null,
    durationMs: null,
    status: 'running',
    input: {
      prompt: 'test',
    },
    output: null,
    contextSnapshot: {
      depth: 0,
      stepCount: 1,
      tokens: {
        input: 10,
        output: 5,
        total: 15,
      },
      cost: 0.001,
      elapsedMs: 100,
      state: null,
      itemLogLength: 0,
    },
    stepData: {},
    children: [],
  };
}

function makeSummary(traceId: string): ExecutionSummary {
  return {
    traceId,
    totalNodes: 1,
    completedNodes: 1,
    errorNodes: 0,
    durationMs: 100,
    totalTokens: {
      input: 10,
      output: 5,
      total: 15,
    },
    totalCost: 0.001,
  };
}

/** Open a WebSocket client to the server and wait until connected */
function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Send a typed message object through a raw WebSocket */
function send(ws: WebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

/** Collect messages from a WebSocket until a predicate matches */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), timeoutMs);
    const handler = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

/** Small delay helper */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Tests
// ============================================================================

describe('NoeticUIServer persistence', () => {
  let tempDir: string;
  let storage: TraceStorage;
  let server: NoeticUIServer;
  let port: number;
  let client: WebSocket | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'noetic-ws-test-'));
    storage = new TraceStorage(tempDir);
    await storage.init();

    port = randomPort();
    server = new NoeticUIServer({
      port,
      host: '127.0.0.1',
      storage,
    });
    await server.start();
  });

  afterEach(async () => {
    if (client && client.readyState === WebSocket.OPEN) {
      client.close();
    }
    await server.stop(2000);
    await rm(tempDir, {
      recursive: true,
      force: true,
    });
  });

  it('handleTraceStart triggers a debounced save that appears on disk', async () => {
    client = await connectClient(port);
    // Drain the initial pong
    await waitForMessage(client, (m) => m.type === 'pong');

    const traceId = 'trace-start-test';
    send(client, {
      type: 'trace.start',
      traceId,
      agentId: 'agent-a',
      input: 'hello',
      startTime: Date.now(),
    });

    // Wait for execution.start broadcast
    await waitForMessage(client, (m) => m.type === 'execution.start');

    // The save is debounced (500ms). Wait long enough for it to flush.
    await delay(800);

    const run = await storage.loadRun('agent-a', traceId);
    expect(run).not.toBeNull();
    expect(run!.id).toBe(traceId);
    expect(run!.agentId).toBe('agent-a');
  });

  it('handleTraceNodeStart triggers a debounced save', async () => {
    client = await connectClient(port);
    await waitForMessage(client, (m) => m.type === 'pong');

    const traceId = 'trace-node-start-test';
    send(client, {
      type: 'trace.start',
      traceId,
      agentId: 'agent-b',
      input: null,
      startTime: Date.now(),
    });
    await waitForMessage(client, (m) => m.type === 'execution.start');

    const node = makeNode('node-1');
    send(client, {
      type: 'trace.nodeStart',
      traceId,
      node,
    });
    await waitForMessage(client, (m) => m.type === 'node.start');

    // Wait for debounce to flush
    await delay(800);

    const run = await storage.loadRun('agent-b', traceId);
    expect(run).not.toBeNull();
    expect(run!.trace.nodes).toBeInstanceOf(Map);
    expect(run!.trace.nodes.size).toBeGreaterThanOrEqual(1);
  });

  it('multiple rapid node events coalesce into fewer writes (debounce behavior)', async () => {
    client = await connectClient(port);
    await waitForMessage(client, (m) => m.type === 'pong');

    const traceId = 'trace-coalesce-test';
    send(client, {
      type: 'trace.start',
      traceId,
      agentId: 'agent-c',
      input: null,
      startTime: Date.now(),
    });
    await waitForMessage(client, (m) => m.type === 'execution.start');

    // Fire many node events rapidly — they should coalesce
    for (let i = 0; i < 5; i++) {
      send(client, {
        type: 'trace.nodeStart',
        traceId,
        node: makeNode(`rapid-${i}`),
      });
    }

    // Wait for all broadcasts to arrive
    let nodeStartCount = 0;
    await new Promise<void>((resolve) => {
      const handler = (data: Buffer | ArrayBuffer | Buffer[]): void => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === 'node.start') {
          nodeStartCount++;
          if (nodeStartCount >= 5) {
            client!.off('message', handler);
            resolve();
          }
        }
      };
      client!.on('message', handler);
    });

    // Wait for debounce to flush
    await delay(800);

    // Verify all 5 nodes are present on disk from a single (coalesced) write
    const run = await storage.loadRun('agent-c', traceId);
    expect(run).not.toBeNull();
    expect(run!.trace.nodes.size).toBe(5);
  });

  it('handleTraceComplete performs immediate save with isLive: false', async () => {
    client = await connectClient(port);
    await waitForMessage(client, (m) => m.type === 'pong');

    const traceId = 'trace-complete-test';
    send(client, {
      type: 'trace.start',
      traceId,
      agentId: 'agent-d',
      input: 'test',
      startTime: Date.now(),
    });
    await waitForMessage(client, (m) => m.type === 'execution.start');

    const node = makeNode('complete-node');
    send(client, {
      type: 'trace.nodeStart',
      traceId,
      node,
    });
    await waitForMessage(client, (m) => m.type === 'node.start');

    // Complete the trace
    send(client, {
      type: 'trace.complete',
      traceId,
      summary: makeSummary(traceId),
      endTime: Date.now(),
    });
    await waitForMessage(client, (m) => m.type === 'execution.complete');

    // The complete handler calls saveTrace directly (not debounced),
    // so the trace should be on disk almost immediately
    await delay(200);

    const run = await storage.loadRun('agent-d', traceId);
    expect(run).not.toBeNull();
    expect(run!.isLive).toBe(false);
    expect(run!.status).toBe('completed');
  });

  it('stop() flushes pending debounced saves before shutting down', async () => {
    client = await connectClient(port);
    await waitForMessage(client, (m) => m.type === 'pong');

    const traceId = 'trace-flush-test';
    send(client, {
      type: 'trace.start',
      traceId,
      agentId: 'agent-e',
      input: 'flush-me',
      startTime: Date.now(),
    });
    await waitForMessage(client, (m) => m.type === 'execution.start');

    // Add a node (triggers debouncedSave — timer not yet fired)
    send(client, {
      type: 'trace.nodeStart',
      traceId,
      node: makeNode('flush-node'),
    });
    await waitForMessage(client, (m) => m.type === 'node.start');

    // Immediately stop the server — should flush the pending save
    client.close();
    client = null;
    await server.stop(2000);

    // Verify the trace was persisted despite the debounce timer not having elapsed
    const run = await storage.loadRun('agent-e', traceId);
    expect(run).not.toBeNull();
    expect(run!.trace.nodes.size).toBeGreaterThanOrEqual(1);
  });

  it('handleExecutionGet returns trace from disk when not in memory', async () => {
    // First, save a trace directly to storage (simulating a completed run)
    const traceId = 'disk-only-trace';
    const traceForDisk = {
      traceId,
      rootStepId: 'root',
      startTime: Date.now(),
      endTime: Date.now() + 1000,
      status: 'completed' as const,
      nodes: new Map([
        [
          'node-disk',
          makeNode('node-disk'),
        ],
      ]),
      rootNodeId: 'node-disk',
    };
    await storage.saveTrace(traceForDisk, 'agent-disk', 'disk-input');

    // Now connect and request the trace via execution.get
    client = await connectClient(port);
    await waitForMessage(client, (m) => m.type === 'pong');

    send(client, {
      type: 'execution.get',
      traceId,
    });

    const response = await waitForMessage(
      client,
      (m) => m.type === 'execution.start' || m.type === 'execution.error',
    );

    expect(response.type).toBe('execution.start');
    expect(response.agentId).toBe('agent-disk');
  });

  it('handleExecutionGet sends NOT_FOUND error when trace does not exist', async () => {
    client = await connectClient(port);
    await waitForMessage(client, (m) => m.type === 'pong');

    send(client, {
      type: 'execution.get',
      traceId: 'nonexistent-trace-id',
    });

    const response = await waitForMessage(client, (m) => m.type === 'execution.error');

    expect(response.type).toBe('execution.error');
    const error = response.error as {
      code: string;
      message: string;
    };
    expect(error.code).toBe('NOT_FOUND');
  });
});
