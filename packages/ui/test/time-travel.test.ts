/**
 * Tests for time-travel scrubbing logic
 */

import { describe, expect, it } from 'bun:test';
import {
  calculateScrubState,
  formatPlaybackTime,
  formatStepPosition,
  getMarkerVisualStates,
  getStepKindColor,
  jumpToStepKind,
  navigateStep,
} from '../src/client/lib/time-travel';
import type { TimelineMarker } from '../src/client/stores/timelineStore';
import type { ExecutionNode } from '../src/client/types';

function makeMarker(
  overrides: Partial<TimelineMarker> & {
    id: string;
    nodeId: string;
  },
): TimelineMarker {
  return {
    stepKind: 'run',
    timestamp: 1000,
    duration: 100,
    depth: 0,
    status: 'completed',
    position: 0.5,
    ...overrides,
  };
}

function makeNode(id: string): ExecutionNode {
  return {
    id,
    stepId: id,
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
        input: 0,
        output: 0,
        total: 0,
      },
      cost: 0,
      elapsedMs: 100,
      state: null,
      itemLogLength: 0,
    },
    stepData: {},
    children: [],
  };
}

describe('calculateScrubState', () => {
  it('returns null node for empty markers', () => {
    const result = calculateScrubState({
      position: 0.5,
      markers: [],
      nodes: new Map(),
    });

    expect(result.currentNode).toBeNull();
    expect(result.stepIndex).toBe(0);
    expect(result.progress).toBe(0.5);
    expect(result.timestamp).toBe(0);
  });

  it('snaps to nearest marker within threshold', () => {
    const markers: TimelineMarker[] = [
      makeMarker({
        id: 'm1',
        nodeId: 'n1',
        position: 0.0,
        timestamp: 0,
      }),
      makeMarker({
        id: 'm2',
        nodeId: 'n2',
        position: 0.5,
        timestamp: 500,
      }),
      makeMarker({
        id: 'm3',
        nodeId: 'n3',
        position: 1.0,
        timestamp: 1000,
      }),
    ];
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('n2', makeNode('n2'));

    const result = calculateScrubState({
      position: 0.51, // within default snapThreshold of 0.02
      markers,
      nodes,
    });

    expect(result.currentNode).not.toBeNull();
    expect(result.currentNode!.id).toBe('n2');
    expect(result.progress).toBe(0.5);
    expect(result.stepIndex).toBe(1);
    expect(result.timestamp).toBe(500);
  });

  it('interpolates between markers when not snapping', () => {
    const markers: TimelineMarker[] = [
      makeMarker({
        id: 'm1',
        nodeId: 'n1',
        position: 0.0,
        timestamp: 0,
      }),
      makeMarker({
        id: 'm2',
        nodeId: 'n2',
        position: 1.0,
        timestamp: 1000,
      }),
    ];
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('n1', makeNode('n1'));
    nodes.set('n2', makeNode('n2'));

    const result = calculateScrubState({
      position: 0.5,
      markers,
      nodes,
      options: {
        snapToSteps: false,
      },
    });

    expect(result.progress).toBe(0.5);
    // Timestamp should be interpolated: 0 + (1000-0) * 0.5 = 500
    expect(result.timestamp).toBe(500);
  });

  it('uses last marker before position as current step', () => {
    const markers: TimelineMarker[] = [
      makeMarker({
        id: 'm1',
        nodeId: 'n1',
        position: 0.0,
        timestamp: 0,
      }),
      makeMarker({
        id: 'm2',
        nodeId: 'n2',
        position: 0.3,
        timestamp: 300,
      }),
      makeMarker({
        id: 'm3',
        nodeId: 'n3',
        position: 0.8,
        timestamp: 800,
      }),
    ];
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('n2', makeNode('n2'));

    const result = calculateScrubState({
      position: 0.5,
      markers,
      nodes,
      options: {
        snapToSteps: false,
      },
    });

    // The node at index 1 (position 0.3) is the last before 0.5
    expect(result.stepIndex).toBe(1);
  });
});

describe('navigateStep', () => {
  const markers: TimelineMarker[] = [
    makeMarker({
      id: 'm1',
      nodeId: 'n1',
      position: 0.0,
    }),
    makeMarker({
      id: 'm2',
      nodeId: 'n2',
      position: 0.5,
    }),
    makeMarker({
      id: 'm3',
      nodeId: 'n3',
      position: 1.0,
    }),
  ];

  it('moves forward', () => {
    const result = navigateStep('forward', 0, markers);
    expect(result).not.toBeNull();
    expect(result!.newIndex).toBe(1);
    expect(result!.newPosition).toBe(0.5);
  });

  it('moves backward', () => {
    const result = navigateStep('backward', 2, markers);
    expect(result).not.toBeNull();
    expect(result!.newIndex).toBe(1);
    expect(result!.newPosition).toBe(0.5);
  });

  it('clamps forward at end', () => {
    const result = navigateStep('forward', 2, markers);
    expect(result).not.toBeNull();
    expect(result!.newIndex).toBe(2); // stays at last
  });

  it('clamps backward at start', () => {
    const result = navigateStep('backward', 0, markers);
    expect(result).not.toBeNull();
    expect(result!.newIndex).toBe(0); // stays at first
  });

  it('returns null for empty markers', () => {
    const result = navigateStep('forward', 0, []);
    expect(result).toBeNull();
  });
});

describe('jumpToStepKind', () => {
  const markers: TimelineMarker[] = [
    makeMarker({
      id: 'm1',
      nodeId: 'n1',
      position: 0.0,
      stepKind: 'run',
    }),
    makeMarker({
      id: 'm2',
      nodeId: 'n2',
      position: 0.3,
      stepKind: 'llm',
    }),
    makeMarker({
      id: 'm3',
      nodeId: 'n3',
      position: 0.6,
      stepKind: 'tool',
    }),
    makeMarker({
      id: 'm4',
      nodeId: 'n4',
      position: 0.9,
      stepKind: 'llm',
    }),
  ];

  it('jumps forward to next matching kind', () => {
    const result = jumpToStepKind({
      kind: 'llm',
      currentIndex: 0,
      markers,
      direction: 'forward',
    });
    expect(result).not.toBeNull();
    expect(result!.newIndex).toBe(1);
  });

  it('jumps backward to previous matching kind', () => {
    const result = jumpToStepKind({
      kind: 'llm',
      currentIndex: 3,
      markers,
      direction: 'backward',
    });
    expect(result).not.toBeNull();
    expect(result!.newIndex).toBe(1);
  });

  it('returns null when no matching kind found', () => {
    const result = jumpToStepKind({
      kind: 'fork',
      currentIndex: 0,
      markers,
      direction: 'forward',
    });
    expect(result).toBeNull();
  });
});

describe('getMarkerVisualStates', () => {
  it('classifies markers as past, current, and future', () => {
    const markers: TimelineMarker[] = [
      makeMarker({
        id: 'm1',
        nodeId: 'n1',
        position: 0.0,
      }),
      makeMarker({
        id: 'm2',
        nodeId: 'n2',
        position: 0.5,
      }),
      makeMarker({
        id: 'm3',
        nodeId: 'n3',
        position: 1.0,
      }),
    ];

    const states = getMarkerVisualStates({
      playheadPosition: 0.5,
      markers,
    });

    expect(states).toHaveLength(3);
    expect(states[0].isPast).toBe(true);
    expect(states[0].isCurrent).toBe(false);
    expect(states[0].isFuture).toBe(false);

    expect(states[1].isPast).toBe(false);
    expect(states[1].isCurrent).toBe(true);
    expect(states[1].isFuture).toBe(false);

    expect(states[2].isPast).toBe(false);
    expect(states[2].isCurrent).toBe(false);
    expect(states[2].isFuture).toBe(true);
  });
});

describe('formatStepPosition', () => {
  it('formats step 0 of 10 as "Step 1 / 10"', () => {
    expect(formatStepPosition(0, 10)).toBe('Step 1 / 10');
  });

  it('formats step 9 of 10 as "Step 10 / 10"', () => {
    expect(formatStepPosition(9, 10)).toBe('Step 10 / 10');
  });

  it('formats step 0 of 1 as "Step 1 / 1"', () => {
    expect(formatStepPosition(0, 1)).toBe('Step 1 / 1');
  });
});

describe('formatPlaybackTime', () => {
  it('formats 0ms as "0:00"', () => {
    expect(formatPlaybackTime(0)).toBe('0:00');
  });

  it('formats 1000ms as "0:01"', () => {
    expect(formatPlaybackTime(1000)).toBe('0:01');
  });

  it('formats 60000ms as "1:00"', () => {
    expect(formatPlaybackTime(60000)).toBe('1:00');
  });

  it('formats 3661000ms as "1:01:01"', () => {
    expect(formatPlaybackTime(3661000)).toBe('1:01:01');
  });

  it('formats 45023ms as "0:45"', () => {
    // 45023ms = 45 seconds + 23ms, floors to 45 seconds
    expect(formatPlaybackTime(45023)).toBe('0:45');
  });

  it('pads minutes and seconds with zeros for hours format', () => {
    // 3600000ms = 1 hour exactly
    expect(formatPlaybackTime(3600000)).toBe('1:00:00');
  });
});

describe('getStepKindColor', () => {
  it('returns purple for llm', () => {
    expect(getStepKindColor('llm')).toBe('#8b5cf6');
  });

  it('returns orange for tool', () => {
    expect(getStepKindColor('tool')).toBe('#f97316');
  });

  it('returns cyan for run', () => {
    expect(getStepKindColor('run')).toBe('#06b6d4');
  });

  it('returns a valid hex color for all known kinds', () => {
    const kinds = [
      'llm',
      'tool',
      'run',
      'branch',
      'fork',
      'spawn',
      'loop',
    ] as const;
    for (const kind of kinds) {
      const color = getStepKindColor(kind);
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('returns gray for unknown kind', () => {
    // Call at the JS level to test runtime fallback for unrecognized kinds
    const call = Function.prototype.bind.call(getStepKindColor, null, 'unknown');
    expect(call()).toBe('#6b7280');
  });
});
