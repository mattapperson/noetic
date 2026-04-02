/**
 * Tests for NoeticUITraceExporter
 *
 * Verifies the exporter correctly handles the core interpreter's
 * depth-first, one-span-at-a-time export pattern, producing
 * a complete trace with all nodes and proper parent-child hierarchy.
 */

import { describe, expect, it } from 'bun:test';

/**
 * Since NoeticUITraceExporter uses `ws` (WebSocket) which tries to connect,
 * we test the exporter's span→message logic by simulating its internal behavior.
 * This tests the data model, not the WebSocket transport.
 */

interface CapturedMessage {
  type: string;
  [key: string]: unknown;
}

/** Minimal span that mirrors SpanImpl's shape */
interface TestSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Map<string, string | number | boolean>;
}

function createSpan(name: string, parent: TestSpan | null, traceId?: string): TestSpan {
  return {
    traceId: traceId ?? parent?.traceId ?? crypto.randomUUID(),
    spanId: crypto.randomUUID(),
    parentSpanId: parent?.spanId ?? null,
    name,
    startTime: Date.now(),
    attributes: new Map(),
  };
}

function endSpan(span: TestSpan): void {
  span.endTime = Date.now();
}

/**
 * Simulates the exporter's span processing logic without WebSocket.
 * Replicates the trace.start → trace.nodeStart → trace.complete flow
 * matching the fixed exporter logic.
 */
function createTestExporter(): {
  exportSpan: (span: TestSpan) => void;
  getMessages: () => CapturedMessage[];
} {
  const messages: CapturedMessage[] = [];
  const activeTraces = new Map<string, {
    startTime: number;
    spanIds: Set<string>;
    allSpans: TestSpan[];
    started: boolean;
  }>();

  function exportSpan(span: TestSpan): void {
    const traceId = span.traceId;
    const traceInfo = activeTraces.get(traceId) ?? {
      startTime: Date.now(),
      spanIds: new Set<string>(),
      allSpans: [],
      started: false,
    };

    if (!traceInfo.started) {
      messages.push({ type: 'trace.start', traceId });
      traceInfo.started = true;
    }

    traceInfo.allSpans.push(span);

    if (!traceInfo.spanIds.has(span.spanId)) {
      traceInfo.spanIds.add(span.spanId);
      messages.push({
        type: 'trace.nodeStart',
        traceId,
        nodeId: span.spanId,
        stepId: span.name,
        parentId: span.parentSpanId,
        kind: String(span.attributes.get('stepKind') ?? 'run'),
      });
    }

    activeTraces.set(traceId, traceInfo);

    // Check completion: root span (no parent) with endTime
    const rootSpan = traceInfo.allSpans.find((s) => !s.parentSpanId && s.endTime);
    if (rootSpan) {
      messages.push({
        type: 'trace.complete',
        traceId,
        totalSteps: traceInfo.allSpans.length,
      });
      activeTraces.delete(traceId);
    }
  }

  return { exportSpan, getMessages: () => messages };
}

describe('exporter span processing', () => {
  it('produces all nodes for a multi-step execution (depth-first export)', () => {
    const { exportSpan, getMessages } = createTestExporter();

    // Simulate: loop → branch → step.run (depth-first completion order)
    const rootSpan = createSpan('my-loop', null);
    rootSpan.attributes.set('stepKind', 'loop');
    const traceId = rootSpan.traceId;

    const branchSpan = createSpan('router', rootSpan);
    branchSpan.attributes.set('stepKind', 'branch');

    const handlerSpan = createSpan('billing-handler', branchSpan);
    handlerSpan.attributes.set('stepKind', 'run');

    // Innermost step completes first (depth-first)
    endSpan(handlerSpan);
    exportSpan(handlerSpan);

    // Branch completes
    endSpan(branchSpan);
    exportSpan(branchSpan);

    // Root completes last
    endSpan(rootSpan);
    exportSpan(rootSpan);

    const msgs = getMessages();

    // Should have: 1 trace.start + 3 nodeStarts + 1 trace.complete
    expect(msgs.filter((m) => m.type === 'trace.start')).toHaveLength(1);
    expect(msgs.filter((m) => m.type === 'trace.nodeStart')).toHaveLength(3);
    expect(msgs.filter((m) => m.type === 'trace.complete')).toHaveLength(1);

    // trace.complete should report all 3 steps
    const complete = msgs.find((m) => m.type === 'trace.complete');
    expect(complete?.totalSteps).toBe(3);

    // Verify parent-child relationships
    const nodes = msgs.filter((m) => m.type === 'trace.nodeStart');
    const handlerNode = nodes.find((n) => n.stepId === 'billing-handler');
    const branchNode = nodes.find((n) => n.stepId === 'router');
    const loopNode = nodes.find((n) => n.stepId === 'my-loop');

    expect(handlerNode?.parentId).toBe(branchSpan.spanId);
    expect(branchNode?.parentId).toBe(rootSpan.spanId);
    expect(loopNode?.parentId).toBeNull();

    // All should share the same traceId
    for (const node of nodes) {
      expect(node.traceId).toBe(traceId);
    }
  });

  it('does not send trace.complete until root span ends', () => {
    const { exportSpan, getMessages } = createTestExporter();

    const rootSpan = createSpan('pipeline', null);
    const childSpan = createSpan('step-1', rootSpan);

    // Child completes
    endSpan(childSpan);
    exportSpan(childSpan);

    // At this point: trace.start + 1 nodeStart, but NO trace.complete
    let msgs = getMessages();
    expect(msgs.filter((m) => m.type === 'trace.complete')).toHaveLength(0);
    expect(msgs.filter((m) => m.type === 'trace.nodeStart')).toHaveLength(1);

    // Root completes
    endSpan(rootSpan);
    exportSpan(rootSpan);

    msgs = getMessages();
    expect(msgs.filter((m) => m.type === 'trace.complete')).toHaveLength(1);
    expect(msgs.filter((m) => m.type === 'trace.nodeStart')).toHaveLength(2);
  });

  it('sends trace.start only once even when spans arrive in separate flushes', () => {
    const { exportSpan, getMessages } = createTestExporter();

    const rootSpan = createSpan('agent', null);
    const step1 = createSpan('step-1', rootSpan);
    const step2 = createSpan('step-2', rootSpan);

    // Flush 1: step-1
    endSpan(step1);
    exportSpan(step1);

    // Flush 2: step-2
    endSpan(step2);
    exportSpan(step2);

    // Flush 3: root
    endSpan(rootSpan);
    exportSpan(rootSpan);

    const msgs = getMessages();
    expect(msgs.filter((m) => m.type === 'trace.start')).toHaveLength(1);
  });

  it('handles deeply nested steps correctly', () => {
    const { exportSpan, getMessages } = createTestExporter();

    const root = createSpan('root', null);
    const loop = createSpan('loop-1', root);
    const branch = createSpan('branch-1', loop);
    const llm = createSpan('llm-call', branch);

    // Complete depth-first
    endSpan(llm);
    exportSpan(llm);
    endSpan(branch);
    exportSpan(branch);
    endSpan(loop);
    exportSpan(loop);
    endSpan(root);
    exportSpan(root);

    const msgs = getMessages();
    const nodes = msgs.filter((m) => m.type === 'trace.nodeStart');

    expect(nodes).toHaveLength(4);

    // Verify hierarchy
    const llmNode = nodes.find((n) => n.stepId === 'llm-call');
    const branchNode = nodes.find((n) => n.stepId === 'branch-1');
    const loopNode = nodes.find((n) => n.stepId === 'loop-1');
    const rootNode = nodes.find((n) => n.stepId === 'root');

    expect(llmNode?.parentId).toBe(branch.spanId);
    expect(branchNode?.parentId).toBe(loop.spanId);
    expect(loopNode?.parentId).toBe(root.spanId);
    expect(rootNode?.parentId).toBeNull();

    // Only one complete, with all 4 steps
    const complete = msgs.filter((m) => m.type === 'trace.complete');
    expect(complete).toHaveLength(1);
    expect(complete[0].totalSteps).toBe(4);
  });

  it('handles loop iterations (same step executed multiple times)', () => {
    const { exportSpan, getMessages } = createTestExporter();

    const root = createSpan('loop', null);
    root.attributes.set('stepKind', 'loop');

    // Iteration 1
    const iter1 = createSpan('handler', root);
    endSpan(iter1);
    exportSpan(iter1);

    // Iteration 2 — same step name, different span
    const iter2 = createSpan('handler', root);
    endSpan(iter2);
    exportSpan(iter2);

    // Loop completes
    endSpan(root);
    exportSpan(root);

    const msgs = getMessages();
    const nodes = msgs.filter((m) => m.type === 'trace.nodeStart');

    // 3 nodes: loop + 2 iterations (each iteration is a distinct span)
    expect(nodes).toHaveLength(3);
    expect(nodes.filter((n) => n.stepId === 'handler')).toHaveLength(2);

    // Both iterations have the loop as parent
    const handlerNodes = nodes.filter((n) => n.stepId === 'handler');
    for (const node of handlerNodes) {
      expect(node.parentId).toBe(root.spanId);
    }
  });
});
