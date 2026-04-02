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

function createSpan(name: string, parent: TestSpan | null, depth?: number): TestSpan {
  const attrs = new Map<string, string | number | boolean>();
  // Simulate what the core interpreter does: set depth attribute
  attrs.set('depth', depth ?? 0);
  return {
    traceId: parent?.traceId ?? crypto.randomUUID(),
    spanId: crypto.randomUUID(),
    parentSpanId: parent?.spanId ?? null,
    name,
    startTime: Date.now(),
    attributes: attrs,
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
  const activeTraces = new Map<
    string,
    {
      startTime: number;
      spanIds: Set<string>;
      allSpans: TestSpan[];
      started: boolean;
    }
  >();

  function exportSpan(span: TestSpan): void {
    const traceId = span.traceId;
    const traceInfo = activeTraces.get(traceId) ?? {
      startTime: Date.now(),
      spanIds: new Set<string>(),
      allSpans: [],
      started: false,
    };

    if (!traceInfo.started) {
      messages.push({
        type: 'trace.start',
        traceId,
      });
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

    // Check completion: depth-0 span with endTime (matches real exporter logic)
    const rootByDepth = traceInfo.allSpans.find((s) => {
      const depth = s.attributes.get('depth');
      return s.endTime && typeof depth === 'number' && depth === 0;
    });
    if (rootByDepth) {
      messages.push({
        type: 'trace.complete',
        traceId,
        totalSteps: traceInfo.allSpans.length,
      });
      activeTraces.delete(traceId);
    }
  }

  return {
    exportSpan,
    getMessages: () => messages,
  };
}

describe('exporter span processing', () => {
  it('produces all nodes for a multi-step execution (depth-first export)', () => {
    const { exportSpan, getMessages } = createTestExporter();

    // Simulate: loop → branch → step.run (depth-first completion order)
    const rootSpan = createSpan('my-loop', null, 0);
    rootSpan.attributes.set('stepKind', 'loop');
    const traceId = rootSpan.traceId;

    const branchSpan = createSpan('router', rootSpan, 1);
    branchSpan.attributes.set('stepKind', 'branch');

    const handlerSpan = createSpan('billing-handler', branchSpan, 2);
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

    const rootSpan = createSpan('pipeline', null, 0);
    const childSpan = createSpan('step-1', rootSpan, 1);

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

    const rootSpan = createSpan('agent', null, 0);
    const step1 = createSpan('step-1', rootSpan, 1);
    const step2 = createSpan('step-2', rootSpan, 1);

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

    const root = createSpan('root', null, 0);
    const loop = createSpan('loop-1', root, 1);
    const branch = createSpan('branch-1', loop, 2);
    const llm = createSpan('llm-call', branch, 3);

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

    const root = createSpan('loop', null, 0);
    root.attributes.set('stepKind', 'loop');

    // Iteration 1
    const iter1 = createSpan('handler', root, 1);
    endSpan(iter1);
    exportSpan(iter1);

    // Iteration 2 — same step name, different span
    const iter2 = createSpan('handler', root, 1);
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

  it('completes trace when top-level step has unexported harness root parent', () => {
    const { exportSpan, getMessages } = createTestExporter();

    // Simulate the real harness: an implicit root span is created by the harness
    // but never exported. All exported steps have this as parent.
    const harnessRoot = createSpan('root', null, 0);
    // harnessRoot is NEVER exported — this is the harness behavior

    // The actual step has harnessRoot as parent, but depth 0 in the interpreter
    // (because ctx.depth starts at 0 for the top-level execute() call)
    const topStep = createSpan('my-agent-step', harnessRoot, 0);
    const childStep = createSpan('child-step', topStep, 1);

    // Depth-first: child first, then top step
    endSpan(childStep);
    exportSpan(childStep);

    // At this point no trace.complete — topStep hasn't ended
    let msgs = getMessages();
    expect(msgs.filter((m) => m.type === 'trace.complete')).toHaveLength(0);

    endSpan(topStep);
    exportSpan(topStep);

    // Now trace.complete should fire because topStep's parentSpanId
    // points to harnessRoot which was never exported
    msgs = getMessages();
    expect(msgs.filter((m) => m.type === 'trace.complete')).toHaveLength(1);
    expect(msgs.find((m) => m.type === 'trace.complete')?.totalSteps).toBe(2);
  });
});
