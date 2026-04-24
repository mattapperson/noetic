/**
 * Tests for exporter span processing logic.
 *
 * Verifies:
 * - Each step produces a trace.nodeStart message
 * - trace.start is sent exactly once per trace
 * - trace.complete is only sent via explicit completeTrace() (not auto-detected)
 * - trace.error is sent when completeTrace receives an error
 * - Parent-child relationships are preserved via parentSpanId
 * - Loop iterations produce distinct nodes
 */

import { describe, expect, it } from 'bun:test';

//#region Test Helpers

interface CapturedMessage {
  type: string;
  [key: string]: unknown;
}

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
 * trace.complete is only sent via explicit completeTrace() — matching
 * the real exporter which relies on the harness to signal completion.
 */
function createTestExporter(): {
  exportSpan: (span: TestSpan) => void;
  completeTrace: (traceId: string, error?: Error) => void;
  getMessages: () => CapturedMessage[];
} {
  const messages: CapturedMessage[] = [];
  const activeTraces = new Map<
    string,
    {
      spanIds: Set<string>;
      allSpans: TestSpan[];
      started: boolean;
    }
  >();

  function exportSpan(span: TestSpan): void {
    const traceId = span.traceId;
    const traceInfo = activeTraces.get(traceId) ?? {
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
  }

  function completeTrace(traceId: string, error?: Error): void {
    const traceInfo = activeTraces.get(traceId);
    if (!traceInfo) {
      return;
    }
    if (error) {
      messages.push({
        type: 'trace.error',
        traceId,
        error: {
          message: error.message,
          stack: error.stack,
        },
      });
    } else {
      messages.push({
        type: 'trace.complete',
        traceId,
        totalSteps: traceInfo.allSpans.length,
      });
    }
    activeTraces.delete(traceId);
  }

  return {
    exportSpan,
    completeTrace,
    getMessages: () => messages,
  };
}

//#endregion

describe('exporter span processing', () => {
  it('produces all nodes for a multi-step execution (depth-first export)', () => {
    const { exportSpan, completeTrace, getMessages } = createTestExporter();

    const rootSpan = createSpan('my-loop', null, 0);
    rootSpan.attributes.set('stepKind', 'loop');
    const traceId = rootSpan.traceId;

    const branchSpan = createSpan('router', rootSpan, 1);
    branchSpan.attributes.set('stepKind', 'branch');

    const handlerSpan = createSpan('billing-handler', branchSpan, 2);
    handlerSpan.attributes.set('stepKind', 'run');

    // Depth-first: innermost completes first
    endSpan(handlerSpan);
    exportSpan(handlerSpan);
    endSpan(branchSpan);
    exportSpan(branchSpan);
    endSpan(rootSpan);
    exportSpan(rootSpan);

    // No trace.complete yet — must be explicit
    expect(getMessages().filter((m) => m.type === 'trace.complete')).toHaveLength(0);

    // Harness signals completion
    completeTrace(traceId);

    const msgs = getMessages();
    expect(msgs.filter((m) => m.type === 'trace.start')).toHaveLength(1);
    expect(msgs.filter((m) => m.type === 'trace.nodeStart')).toHaveLength(3);
    expect(msgs.filter((m) => m.type === 'trace.complete')).toHaveLength(1);
    expect(msgs.find((m) => m.type === 'trace.complete')?.totalSteps).toBe(3);

    // Verify parent-child relationships
    const nodes = msgs.filter((m) => m.type === 'trace.nodeStart');
    expect(nodes.find((n) => n.stepId === 'billing-handler')?.parentId).toBe(branchSpan.spanId);
    expect(nodes.find((n) => n.stepId === 'router')?.parentId).toBe(rootSpan.spanId);
    expect(nodes.find((n) => n.stepId === 'my-loop')?.parentId).toBeNull();

    for (const node of nodes) {
      expect(node.traceId).toBe(traceId);
    }
  });

  it('does not auto-complete — requires explicit completeTrace call', () => {
    const { exportSpan, getMessages } = createTestExporter();

    const rootSpan = createSpan('pipeline', null, 0);
    const childSpan = createSpan('step-1', rootSpan, 0); // same depth (loop reuse)

    endSpan(childSpan);
    exportSpan(childSpan);
    endSpan(rootSpan);
    exportSpan(rootSpan);

    // Even with all spans exported and ended, no auto-complete
    const msgs = getMessages();
    expect(msgs.filter((m) => m.type === 'trace.complete')).toHaveLength(0);
    expect(msgs.filter((m) => m.type === 'trace.nodeStart')).toHaveLength(2);
  });

  it('sends trace.start only once even when spans arrive in separate flushes', () => {
    const { exportSpan, getMessages } = createTestExporter();

    const rootSpan = createSpan('agent', null, 0);
    const step1 = createSpan('step-1', rootSpan, 0);
    const step2 = createSpan('step-2', rootSpan, 0);

    endSpan(step1);
    exportSpan(step1);
    endSpan(step2);
    exportSpan(step2);
    endSpan(rootSpan);
    exportSpan(rootSpan);

    expect(getMessages().filter((m) => m.type === 'trace.start')).toHaveLength(1);
  });

  it('handles deeply nested steps correctly', () => {
    const { exportSpan, completeTrace, getMessages } = createTestExporter();

    const root = createSpan('root', null, 0);
    const loop = createSpan('loop-1', root, 0);
    const branch = createSpan('branch-1', loop, 0);
    const llm = createSpan('llm-call', branch, 0);

    endSpan(llm);
    exportSpan(llm);
    endSpan(branch);
    exportSpan(branch);
    endSpan(loop);
    exportSpan(loop);
    endSpan(root);
    exportSpan(root);

    completeTrace(root.traceId);

    const msgs = getMessages();
    const nodes = msgs.filter((m) => m.type === 'trace.nodeStart');
    expect(nodes).toHaveLength(4);

    expect(nodes.find((n) => n.stepId === 'llm-call')?.parentId).toBe(branch.spanId);
    expect(nodes.find((n) => n.stepId === 'branch-1')?.parentId).toBe(loop.spanId);
    expect(nodes.find((n) => n.stepId === 'loop-1')?.parentId).toBe(root.spanId);
    expect(nodes.find((n) => n.stepId === 'root')?.parentId).toBeNull();

    const complete = msgs.filter((m) => m.type === 'trace.complete');
    expect(complete).toHaveLength(1);
    expect(complete[0].totalSteps).toBe(4);
  });

  it('handles loop iterations with same depth (context reuse)', () => {
    const { exportSpan, completeTrace, getMessages } = createTestExporter();

    const root = createSpan('loop', null, 0);
    root.attributes.set('stepKind', 'loop');

    // Both iterations have depth 0 (context reuse — the actual bug scenario)
    const iter1 = createSpan('handler', root, 0);
    endSpan(iter1);
    exportSpan(iter1);

    // No premature trace.complete after first span
    expect(getMessages().filter((m) => m.type === 'trace.complete')).toHaveLength(0);

    const iter2 = createSpan('handler', root, 0);
    endSpan(iter2);
    exportSpan(iter2);

    endSpan(root);
    exportSpan(root);

    completeTrace(root.traceId);

    const msgs = getMessages();
    const nodes = msgs.filter((m) => m.type === 'trace.nodeStart');

    // 3 nodes: loop + 2 iterations
    expect(nodes).toHaveLength(3);
    expect(nodes.filter((n) => n.stepId === 'handler')).toHaveLength(2);

    for (const node of nodes.filter((n) => n.stepId === 'handler')) {
      expect(node.parentId).toBe(root.spanId);
    }
  });

  it('sends trace.error instead of trace.complete when error is provided', () => {
    const { exportSpan, completeTrace, getMessages } = createTestExporter();

    const root = createSpan('agent', null, 0);
    const step = createSpan('llm-call', root, 1);

    endSpan(step);
    exportSpan(step);
    endSpan(root);
    exportSpan(root);

    const error = new Error('TooManyRequestsResponseError: Provider returned error');
    completeTrace(root.traceId, error);

    const msgs = getMessages();
    expect(msgs.filter((m) => m.type === 'trace.complete')).toHaveLength(0);
    expect(msgs.filter((m) => m.type === 'trace.error')).toHaveLength(1);

    const errorMsg = msgs.find((m) => m.type === 'trace.error');
    expect(errorMsg?.traceId).toBe(root.traceId);

    const errorData = errorMsg?.error as {
      message: string;
      stack?: string;
    };
    expect(errorData.message).toBe('TooManyRequestsResponseError: Provider returned error');
    expect(errorData.stack).toBeDefined();
  });

  it('handles harness root parent (unexported parent span)', () => {
    const { exportSpan, completeTrace, getMessages } = createTestExporter();

    // Harness creates an implicit root span that is never exported
    const harnessRoot = createSpan('root', null, 0);

    const topStep = createSpan('my-agent-step', harnessRoot, 0);
    const childStep = createSpan('child-step', topStep, 0);

    endSpan(childStep);
    exportSpan(childStep);
    endSpan(topStep);
    exportSpan(topStep);

    // No auto-complete
    expect(getMessages().filter((m) => m.type === 'trace.complete')).toHaveLength(0);

    completeTrace(topStep.traceId);

    const msgs = getMessages();
    expect(msgs.filter((m) => m.type === 'trace.complete')).toHaveLength(1);
    expect(msgs.find((m) => m.type === 'trace.complete')?.totalSteps).toBe(2);
  });
});
