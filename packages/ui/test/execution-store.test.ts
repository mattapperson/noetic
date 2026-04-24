/**
 * Tests for useExecutionStore
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { useExecutionStore } from '../src/client/stores/execution';
import type { ExecutionNode, ExecutionTrace } from '../src/shared/protocol';

// #region Helpers

function makeNode(id: string, overrides: Partial<ExecutionNode> = {}): ExecutionNode {
  return {
    id,
    stepId: `step-${id}`,
    kind: 'run',
    parentId: null,
    depth: 0,
    startTime: 1000,
    endTime: 1100,
    durationMs: 100,
    status: 'completed',
    input: null,
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
    ...overrides,
  };
}

function makeTrace(traceId: string, nodeIds: string[] = []): ExecutionTrace {
  const nodes = new Map<string, ExecutionNode>();
  for (const id of nodeIds) {
    nodes.set(id, makeNode(id));
  }
  return {
    traceId,
    rootStepId: 'root',
    startTime: 1000,
    endTime: 2000,
    status: 'completed',
    nodes,
    rootNodeId: nodeIds[0] ?? '',
  };
}

// #endregion

beforeEach(() => {
  useExecutionStore.getState().clearTraceCache();
  useExecutionStore.setState({
    currentTimelinePosition: 0,
    isPlaying: false,
    playbackSpeed: 1,
  });
});

describe('setTrace', () => {
  it('stores the trace in the traces map', () => {
    const trace = makeTrace('trace-1', [
      'node-a',
    ]);
    useExecutionStore.getState().setTrace('trace-1', trace);

    const { traces } = useExecutionStore.getState();
    expect(traces.get('trace-1')).toBe(trace);
  });

  it('populates the nodes map from the trace nodes', () => {
    const trace = makeTrace('trace-1', [
      'node-a',
      'node-b',
    ]);
    useExecutionStore.getState().setTrace('trace-1', trace);

    const { nodes } = useExecutionStore.getState();
    expect(nodes.size).toBe(2);
    expect(nodes.has('node-a')).toBe(true);
    expect(nodes.has('node-b')).toBe(true);
  });

  it('replaces nodes when switching to a new trace (not accumulates)', () => {
    const trace1 = makeTrace('trace-1', [
      'node-old-1',
      'node-old-2',
    ]);
    useExecutionStore.getState().setTrace('trace-1', trace1);

    const trace2 = makeTrace('trace-2', [
      'node-new-1',
    ]);
    useExecutionStore.getState().setTrace('trace-2', trace2);

    const { nodes } = useExecutionStore.getState();
    expect(nodes.size).toBe(1);
    expect(nodes.has('node-new-1')).toBe(true);
    expect(nodes.has('node-old-1')).toBe(false);
    expect(nodes.has('node-old-2')).toBe(false);
  });

  it('preserves all previous traces in the traces map', () => {
    const trace1 = makeTrace('trace-1', [
      'node-a',
    ]);
    const trace2 = makeTrace('trace-2', [
      'node-b',
    ]);
    useExecutionStore.getState().setTrace('trace-1', trace1);
    useExecutionStore.getState().setTrace('trace-2', trace2);

    const { traces } = useExecutionStore.getState();
    expect(traces.size).toBe(2);
    expect(traces.has('trace-1')).toBe(true);
    expect(traces.has('trace-2')).toBe(true);
  });

  it('works with an empty trace (no nodes)', () => {
    const trace = makeTrace('trace-empty');
    useExecutionStore.getState().setTrace('trace-empty', trace);

    const { nodes, traces } = useExecutionStore.getState();
    expect(traces.has('trace-empty')).toBe(true);
    expect(nodes.size).toBe(0);
  });
});

describe('setNode', () => {
  it('adds a node to the nodes map', () => {
    const node = makeNode('node-x');
    useExecutionStore.getState().setNode('node-x', node);

    const { nodes } = useExecutionStore.getState();
    expect(nodes.get('node-x')).toBe(node);
  });

  it('overwrites an existing node with the same id', () => {
    const original = makeNode('node-x', {
      status: 'running',
    });
    useExecutionStore.getState().setNode('node-x', original);

    const updated = makeNode('node-x', {
      status: 'completed',
    });
    useExecutionStore.getState().setNode('node-x', updated);

    const { nodes } = useExecutionStore.getState();
    expect(nodes.get('node-x')?.status).toBe('completed');
  });

  it('does not affect other nodes', () => {
    const trace = makeTrace('trace-1', [
      'node-a',
      'node-b',
    ]);
    useExecutionStore.getState().setTrace('trace-1', trace);

    const newNode = makeNode('node-c');
    useExecutionStore.getState().setNode('node-c', newNode);

    const { nodes } = useExecutionStore.getState();
    expect(nodes.size).toBe(3);
    expect(nodes.has('node-a')).toBe(true);
    expect(nodes.has('node-b')).toBe(true);
    expect(nodes.has('node-c')).toBe(true);
  });
});

describe('updateNode', () => {
  it('merges partial updates into an existing node', () => {
    const node = makeNode('node-u', {
      status: 'running',
      endTime: null,
      durationMs: null,
    });
    useExecutionStore.getState().setNode('node-u', node);

    useExecutionStore.getState().updateNode('node-u', {
      status: 'completed',
      durationMs: 250,
    });

    const { nodes } = useExecutionStore.getState();
    const updated = nodes.get('node-u');
    expect(updated?.status).toBe('completed');
    expect(updated?.durationMs).toBe(250);
    // Unrelated fields preserved
    expect(updated?.stepId).toBe('step-node-u');
  });

  it('does not change state when nodeId does not exist', () => {
    const trace = makeTrace('trace-1', [
      'node-a',
    ]);
    useExecutionStore.getState().setTrace('trace-1', trace);

    const stateBefore = useExecutionStore.getState().nodes;
    useExecutionStore.getState().updateNode('nonexistent', {
      status: 'error',
    });

    const stateAfter = useExecutionStore.getState().nodes;
    // Map reference equality preserved when nothing changes
    expect(stateAfter).toBe(stateBefore);
  });
});

describe('clearTraceCache', () => {
  it('empties the traces map', () => {
    useExecutionStore.getState().setTrace(
      'trace-1',
      makeTrace('trace-1', [
        'n1',
      ]),
    );
    useExecutionStore.getState().clearTraceCache();

    expect(useExecutionStore.getState().traces.size).toBe(0);
  });

  it('empties the nodes map', () => {
    useExecutionStore.getState().setTrace(
      'trace-1',
      makeTrace('trace-1', [
        'n1',
        'n2',
      ]),
    );
    useExecutionStore.getState().clearTraceCache();

    expect(useExecutionStore.getState().nodes.size).toBe(0);
  });
});

describe('setTimelinePosition', () => {
  it('sets a position within [0, 1]', () => {
    useExecutionStore.getState().setTimelinePosition(0.5);
    expect(useExecutionStore.getState().currentTimelinePosition).toBe(0.5);
  });

  it('clamps values below 0 to 0', () => {
    useExecutionStore.getState().setTimelinePosition(-0.1);
    expect(useExecutionStore.getState().currentTimelinePosition).toBe(0);
  });

  it('clamps values above 1 to 1', () => {
    useExecutionStore.getState().setTimelinePosition(1.5);
    expect(useExecutionStore.getState().currentTimelinePosition).toBe(1);
  });

  it('accepts the boundary value 0', () => {
    useExecutionStore.getState().setTimelinePosition(0);
    expect(useExecutionStore.getState().currentTimelinePosition).toBe(0);
  });

  it('accepts the boundary value 1', () => {
    useExecutionStore.getState().setTimelinePosition(1);
    expect(useExecutionStore.getState().currentTimelinePosition).toBe(1);
  });
});

describe('setPlaybackSpeed', () => {
  it('sets a speed within [0.5, 10]', () => {
    useExecutionStore.getState().setPlaybackSpeed(2);
    expect(useExecutionStore.getState().playbackSpeed).toBe(2);
  });

  it('clamps values below 0.5 to 0.5', () => {
    useExecutionStore.getState().setPlaybackSpeed(0.1);
    expect(useExecutionStore.getState().playbackSpeed).toBe(0.5);
  });

  it('clamps values above 10 to 10', () => {
    useExecutionStore.getState().setPlaybackSpeed(20);
    expect(useExecutionStore.getState().playbackSpeed).toBe(10);
  });

  it('accepts the lower boundary 0.5', () => {
    useExecutionStore.getState().setPlaybackSpeed(0.5);
    expect(useExecutionStore.getState().playbackSpeed).toBe(0.5);
  });

  it('accepts the upper boundary 10', () => {
    useExecutionStore.getState().setPlaybackSpeed(10);
    expect(useExecutionStore.getState().playbackSpeed).toBe(10);
  });
});

describe('setIsPlaying', () => {
  it('sets isPlaying to true', () => {
    useExecutionStore.getState().setIsPlaying(true);
    expect(useExecutionStore.getState().isPlaying).toBe(true);
  });

  it('sets isPlaying to false', () => {
    useExecutionStore.getState().setIsPlaying(true);
    useExecutionStore.getState().setIsPlaying(false);
    expect(useExecutionStore.getState().isPlaying).toBe(false);
  });
});
