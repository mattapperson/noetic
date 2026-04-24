/**
 * Tests for the timeline store — markers, scrubbing, and navigation
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { useTimelineStore } from '../src/client/stores/timelineStore';
import type { ExecutionNode, StepKind } from '../src/client/types';

function makeNode(
  id: string,
  opts: {
    kind?: StepKind;
    depth?: number;
    startTime?: number;
    endTime?: number | null;
    durationMs?: number | null;
    status?: ExecutionNode['status'];
  } = {},
): ExecutionNode {
  return {
    id,
    stepId: id,
    kind: opts.kind ?? 'run',
    parentId: null,
    depth: opts.depth ?? 0,
    startTime: opts.startTime ?? 0,
    endTime: opts.endTime ?? null,
    durationMs: opts.durationMs ?? null,
    status: opts.status ?? 'completed',
    input: {},
    output: null,
    contextSnapshot: {
      depth: 0,
      stepCount: 0,
      tokens: {
        input: 0,
        output: 0,
        total: 0,
      },
      cost: 0,
      elapsedMs: 0,
      state: null,
      itemLogLength: 0,
    },
    stepData: {
      description: '',
    },
    children: [],
  };
}

beforeEach(() => {
  useTimelineStore.setState({
    markers: [],
    playheadPosition: 0,
    isDragging: false,
    dragStartPosition: null,
    startTime: 0,
    endTime: 0,
    totalDuration: 0,
    selectedMarkerId: null,
    hoveredMarkerId: null,
    zoom: 1,
    scrollOffset: 0,
  });
});

// ---------------------------------------------------------------------------
// setMarkers
// ---------------------------------------------------------------------------

describe('setMarkers', () => {
  it('creates TimelineMarker objects from ExecutionNode array', () => {
    const nodes = [
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
        durationMs: 1000,
      }),
      makeNode('b', {
        startTime: 500,
        endTime: 1000,
        durationMs: 500,
      }),
    ];
    useTimelineStore.getState().setMarkers(nodes);
    const { markers } = useTimelineStore.getState();
    expect(markers.length).toBe(2);
    expect(markers[0].nodeId).toBe('a');
    expect(markers[1].nodeId).toBe('b');
  });

  it('assigns marker ids as marker-<nodeId>', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('x', {
        startTime: 0,
        endTime: 100,
      }),
    ]);
    const { markers } = useTimelineStore.getState();
    expect(markers[0].id).toBe('marker-x');
  });

  it('resets all timeline state when given empty array', () => {
    // First set some markers to give non-zero state
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
        durationMs: 1000,
      }),
    ]);
    useTimelineStore.getState().setMarkers([]);
    const state = useTimelineStore.getState();
    expect(state.markers).toEqual([]);
    expect(state.startTime).toBe(0);
    expect(state.endTime).toBe(0);
    expect(state.totalDuration).toBe(0);
    expect(state.playheadPosition).toBe(0);
  });

  it('sorts nodes by startTime before building markers', () => {
    const nodes = [
      makeNode('late', {
        startTime: 1000,
        endTime: 1500,
      }),
      makeNode('early', {
        startTime: 0,
        endTime: 500,
      }),
    ];
    useTimelineStore.getState().setMarkers(nodes);
    const { markers } = useTimelineStore.getState();
    expect(markers[0].nodeId).toBe('early');
    expect(markers[1].nodeId).toBe('late');
  });

  it('sets positions 0.0, 0.5, 1.0 for three nodes at 0ms, 500ms, 1000ms', () => {
    const nodes = [
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
        durationMs: 1000,
      }),
      makeNode('b', {
        startTime: 500,
        endTime: 1000,
        durationMs: 500,
      }),
      makeNode('c', {
        startTime: 1000,
        endTime: 1000,
        durationMs: 0,
      }),
    ];
    useTimelineStore.getState().setMarkers(nodes);
    const { markers } = useTimelineStore.getState();
    expect(markers[0].position).toBe(0);
    expect(markers[1].position).toBe(0.5);
    expect(markers[2].position).toBe(1);
  });

  it('sets startTime, endTime, and totalDuration from nodes', () => {
    const nodes = [
      makeNode('a', {
        startTime: 100,
        endTime: 600,
      }),
      makeNode('b', {
        startTime: 200,
        endTime: 600,
      }),
    ];
    useTimelineStore.getState().setMarkers(nodes);
    const state = useTimelineStore.getState();
    expect(state.startTime).toBe(100);
    // endTime comes from last node's endTime (sorted by startTime, so 'b' is last, endTime=600)
    expect(state.totalDuration).toBe(state.endTime - state.startTime);
  });

  it('maps node status to marker status correctly', () => {
    const nodes = [
      makeNode('err', {
        startTime: 0,
        endTime: 100,
        status: 'error',
      }),
      makeNode('paused', {
        startTime: 200,
        endTime: 300,
        status: 'paused',
      }),
      makeNode('running', {
        startTime: 400,
        endTime: 500,
        status: 'running',
      }),
      makeNode('done', {
        startTime: 600,
        endTime: 700,
        status: 'completed',
      }),
      makeNode('pending', {
        startTime: 800,
        endTime: 900,
        status: 'pending',
      }),
    ];
    useTimelineStore.getState().setMarkers(nodes);
    const { markers } = useTimelineStore.getState();
    expect(markers[0].status).toBe('error');
    expect(markers[1].status).toBe('paused');
    expect(markers[2].status).toBe('running');
    expect(markers[3].status).toBe('completed');
    // pending falls through to 'completed'
    expect(markers[4].status).toBe('completed');
  });

  it('uses startTime as endTime when node has no endTime', () => {
    // Single node with no endTime — totalDuration should be 0 and position should be 0
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 500,
        endTime: null,
      }),
    ]);
    const state = useTimelineStore.getState();
    expect(state.totalDuration).toBe(0);
    expect(state.markers[0].position).toBe(0);
  });

  it('copies stepKind and depth from node', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        kind: 'llm',
        depth: 3,
        startTime: 0,
        endTime: 100,
      }),
    ]);
    const marker = useTimelineStore.getState().markers[0];
    expect(marker.stepKind).toBe('llm');
    expect(marker.depth).toBe(3);
  });

  it('uses durationMs for marker duration, defaulting to 0', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 200,
        durationMs: 200,
      }),
      makeNode('b', {
        startTime: 300,
        endTime: 500,
        durationMs: null,
      }),
    ]);
    const { markers } = useTimelineStore.getState();
    expect(markers[0].duration).toBe(200);
    expect(markers[1].duration).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// addMarker
// ---------------------------------------------------------------------------

describe('addMarker', () => {
  it('adds a marker and keeps markers sorted by timestamp', () => {
    // Seed with two nodes to set up startTime and totalDuration
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
      makeNode('c', {
        startTime: 1000,
        endTime: 1000,
      }),
    ]);

    // Add a node in the middle
    useTimelineStore.getState().addMarker(
      makeNode('b', {
        startTime: 500,
        endTime: 1000,
      }),
    );

    const { markers } = useTimelineStore.getState();
    expect(markers.length).toBe(3);
    expect(markers[0].nodeId).toBe('a');
    expect(markers[1].nodeId).toBe('b');
    expect(markers[2].nodeId).toBe('c');
  });

  it('calculates position relative to existing timeline range', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
    ]);
    useTimelineStore.getState().addMarker(
      makeNode('b', {
        startTime: 500,
        endTime: 1000,
      }),
    );
    const marker = useTimelineStore.getState().markers.find((m) => m.nodeId === 'b');
    assert(marker !== undefined);
    expect(marker.position).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// updateMarker
// ---------------------------------------------------------------------------

describe('updateMarker', () => {
  it('merges partial updates into an existing marker', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
        status: 'running',
      }),
    ]);
    const markerId = useTimelineStore.getState().markers[0].id;
    useTimelineStore.getState().updateMarker(markerId, {
      status: 'completed',
      position: 0.75,
    });
    const marker = useTimelineStore.getState().markers[0];
    expect(marker.status).toBe('completed');
    expect(marker.position).toBe(0.75);
    // Other fields remain unchanged
    expect(marker.nodeId).toBe('a');
  });

  it('does not affect other markers', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 500,
      }),
      makeNode('b', {
        startTime: 500,
        endTime: 1000,
      }),
    ]);
    const [markerA, markerB] = useTimelineStore.getState().markers;
    assert(markerA !== undefined);
    assert(markerB !== undefined);
    useTimelineStore.getState().updateMarker(markerA.id, {
      status: 'error',
    });
    const updated = useTimelineStore.getState().markers;
    expect(updated[1].status).toBe(markerB.status);
  });
});

// ---------------------------------------------------------------------------
// setPlayheadPosition
// ---------------------------------------------------------------------------

describe('setPlayheadPosition', () => {
  it('sets playhead position within [0, 1]', () => {
    useTimelineStore.getState().setPlayheadPosition(0.5);
    expect(useTimelineStore.getState().playheadPosition).toBe(0.5);
  });

  it('clamps values below 0 to 0', () => {
    useTimelineStore.getState().setPlayheadPosition(-0.5);
    expect(useTimelineStore.getState().playheadPosition).toBe(0);
  });

  it('clamps values above 1 to 1', () => {
    useTimelineStore.getState().setPlayheadPosition(1.5);
    expect(useTimelineStore.getState().playheadPosition).toBe(1);
  });

  it('accepts boundary values 0 and 1 unchanged', () => {
    useTimelineStore.getState().setPlayheadPosition(0);
    expect(useTimelineStore.getState().playheadPosition).toBe(0);
    useTimelineStore.getState().setPlayheadPosition(1);
    expect(useTimelineStore.getState().playheadPosition).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// setPlayheadToMarker
// ---------------------------------------------------------------------------

describe('setPlayheadToMarker', () => {
  it('sets playhead to the marker position and selects the marker', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
      makeNode('b', {
        startTime: 500,
        endTime: 1000,
      }),
    ]);
    const markerB = useTimelineStore.getState().markers.find((m) => m.nodeId === 'b');
    assert(markerB !== undefined);
    useTimelineStore.getState().setPlayheadToMarker(markerB.id);
    const state = useTimelineStore.getState();
    expect(state.playheadPosition).toBe(markerB.position);
    expect(state.selectedMarkerId).toBe(markerB.id);
  });

  it('does nothing when marker id does not exist', () => {
    useTimelineStore.getState().setPlayheadPosition(0.3);
    useTimelineStore.getState().setPlayheadToMarker('nonexistent');
    expect(useTimelineStore.getState().playheadPosition).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// startDrag / updateDrag / endDrag
// ---------------------------------------------------------------------------

describe('drag operations', () => {
  it('startDrag sets isDragging to true and updates playhead', () => {
    useTimelineStore.getState().startDrag(0.4);
    const state = useTimelineStore.getState();
    expect(state.isDragging).toBe(true);
    expect(state.dragStartPosition).toBe(0.4);
    expect(state.playheadPosition).toBe(0.4);
  });

  it('updateDrag updates playhead position while dragging', () => {
    useTimelineStore.getState().startDrag(0.2);
    useTimelineStore.getState().updateDrag(0.7);
    expect(useTimelineStore.getState().playheadPosition).toBe(0.7);
  });

  it('updateDrag clamps below 0 to 0', () => {
    useTimelineStore.getState().startDrag(0.5);
    useTimelineStore.getState().updateDrag(-0.1);
    expect(useTimelineStore.getState().playheadPosition).toBe(0);
  });

  it('updateDrag clamps above 1 to 1', () => {
    useTimelineStore.getState().startDrag(0.5);
    useTimelineStore.getState().updateDrag(1.5);
    expect(useTimelineStore.getState().playheadPosition).toBe(1);
  });

  it('endDrag sets isDragging to false and clears dragStartPosition', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
    ]);
    useTimelineStore.getState().startDrag(0.3);
    useTimelineStore.getState().endDrag();
    const state = useTimelineStore.getState();
    expect(state.isDragging).toBe(false);
    expect(state.dragStartPosition).toBeNull();
  });

  it('endDrag snaps playhead to nearest marker', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
      makeNode('b', {
        startTime: 1000,
        endTime: 1000,
      }),
    ]);
    // Drag to position close to first marker (0.0)
    useTimelineStore.getState().startDrag(0.05);
    useTimelineStore.getState().endDrag();
    // Should snap to marker 'a' at position 0.0
    expect(useTimelineStore.getState().playheadPosition).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// snapToNearestMarker
// ---------------------------------------------------------------------------

describe('snapToNearestMarker', () => {
  it('snaps playhead to nearest marker and selects it', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
      makeNode('b', {
        startTime: 1000,
        endTime: 1000,
      }),
    ]);
    useTimelineStore.getState().setPlayheadPosition(0.6);
    useTimelineStore.getState().snapToNearestMarker();
    const state = useTimelineStore.getState();
    // Position 0.6 is closer to 1.0 than to 0.0
    expect(state.playheadPosition).toBe(1);
    expect(state.selectedMarkerId).toBe('marker-b');
  });

  it('snaps to closest marker when equidistant — picks first found', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
      makeNode('b', {
        startTime: 1000,
        endTime: 1000,
      }),
    ]);
    // Exactly at 0.0 — nearest is 'a'
    useTimelineStore.getState().setPlayheadPosition(0);
    useTimelineStore.getState().snapToNearestMarker();
    expect(useTimelineStore.getState().selectedMarkerId).toBe('marker-a');
  });

  it('does nothing when there are no markers', () => {
    useTimelineStore.getState().setPlayheadPosition(0.5);
    useTimelineStore.getState().snapToNearestMarker();
    // playhead stays wherever it was
    expect(useTimelineStore.getState().playheadPosition).toBe(0.5);
    expect(useTimelineStore.getState().selectedMarkerId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// selectMarker
// ---------------------------------------------------------------------------

describe('selectMarker', () => {
  it('sets selectedMarkerId and moves playhead to that marker', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
      makeNode('b', {
        startTime: 500,
        endTime: 1000,
      }),
    ]);
    const markerB = useTimelineStore.getState().markers.find((m) => m.nodeId === 'b');
    assert(markerB !== undefined);
    useTimelineStore.getState().selectMarker(markerB.id);
    const state = useTimelineStore.getState();
    expect(state.selectedMarkerId).toBe(markerB.id);
    expect(state.playheadPosition).toBe(markerB.position);
  });

  it('clears selection when called with null', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
    ]);
    const markerId = useTimelineStore.getState().markers[0].id;
    useTimelineStore.getState().selectMarker(markerId);
    useTimelineStore.getState().selectMarker(null);
    expect(useTimelineStore.getState().selectedMarkerId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hoverMarker
// ---------------------------------------------------------------------------

describe('hoverMarker', () => {
  it('sets hoveredMarkerId', () => {
    useTimelineStore.getState().hoverMarker('marker-x');
    expect(useTimelineStore.getState().hoveredMarkerId).toBe('marker-x');
  });

  it('clears hoveredMarkerId when called with null', () => {
    useTimelineStore.getState().hoverMarker('marker-x');
    useTimelineStore.getState().hoverMarker(null);
    expect(useTimelineStore.getState().hoveredMarkerId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getMarkerAtPosition
// ---------------------------------------------------------------------------

describe('getMarkerAtPosition', () => {
  it('returns marker within 0.02 threshold', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
      makeNode('b', {
        startTime: 1000,
        endTime: 1000,
      }),
    ]);
    // position 0.0 for 'a' — query at 0.01 (within threshold)
    const result = useTimelineStore.getState().getMarkerAtPosition(0.01);
    expect(result?.nodeId).toBe('a');
  });

  it('returns null when no marker is within the threshold', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
      makeNode('b', {
        startTime: 1000,
        endTime: 1000,
      }),
    ]);
    // positions are 0.0 and 1.0; query at 0.5 is far from both
    const result = useTimelineStore.getState().getMarkerAtPosition(0.5);
    expect(result).toBeNull();
  });

  it('returns null when there are no markers', () => {
    const result = useTimelineStore.getState().getMarkerAtPosition(0.5);
    expect(result).toBeNull();
  });

  it('does not return marker exactly at threshold boundary (strict less-than)', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
    ]);
    // Exactly 0.02 away — threshold is strict <, so should return null
    const result = useTimelineStore.getState().getMarkerAtPosition(0.02);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getNearestMarker
// ---------------------------------------------------------------------------

describe('getNearestMarker', () => {
  it('returns the closest marker to a given position', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
      makeNode('b', {
        startTime: 1000,
        endTime: 1000,
      }),
    ]);
    // 0.8 is closer to 1.0 than to 0.0
    const result = useTimelineStore.getState().getNearestMarker(0.8);
    expect(result?.nodeId).toBe('b');
  });

  it('returns null when there are no markers', () => {
    const result = useTimelineStore.getState().getNearestMarker(0.5);
    expect(result).toBeNull();
  });

  it('returns the only marker when list has one element', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
    ]);
    const result = useTimelineStore.getState().getNearestMarker(0.99);
    expect(result?.nodeId).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// getMarkerByIndex
// ---------------------------------------------------------------------------

describe('getMarkerByIndex', () => {
  it('returns marker at the given array index', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
      makeNode('b', {
        startTime: 500,
        endTime: 1000,
      }),
    ]);
    const result = useTimelineStore.getState().getMarkerByIndex(1);
    expect(result?.nodeId).toBe('b');
  });

  it('returns null for negative index', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
    ]);
    expect(useTimelineStore.getState().getMarkerByIndex(-1)).toBeNull();
  });

  it('returns null for index equal to markers length', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
    ]);
    expect(useTimelineStore.getState().getMarkerByIndex(1)).toBeNull();
  });

  it('returns null for index greater than markers length', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
    ]);
    expect(useTimelineStore.getState().getMarkerByIndex(5)).toBeNull();
  });

  it('returns null when marker list is empty', () => {
    expect(useTimelineStore.getState().getMarkerByIndex(0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getMarkerIndex
// ---------------------------------------------------------------------------

describe('getMarkerIndex', () => {
  it('returns the index of a marker by id', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
      makeNode('b', {
        startTime: 500,
        endTime: 1000,
      }),
    ]);
    expect(useTimelineStore.getState().getMarkerIndex('marker-b')).toBe(1);
  });

  it('returns -1 when marker id is not found', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
    ]);
    expect(useTimelineStore.getState().getMarkerIndex('nonexistent')).toBe(-1);
  });

  it('returns -1 when marker list is empty', () => {
    expect(useTimelineStore.getState().getMarkerIndex('marker-a')).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// getPositionForIndex
// ---------------------------------------------------------------------------

describe('getPositionForIndex', () => {
  it('returns position for a valid index', () => {
    useTimelineStore.getState().setMarkers([
      makeNode('a', {
        startTime: 0,
        endTime: 1000,
      }),
      makeNode('b', {
        startTime: 1000,
        endTime: 1000,
      }),
    ]);
    expect(useTimelineStore.getState().getPositionForIndex(1)).toBe(1);
  });

  it('returns 0 for an out-of-bounds index', () => {
    expect(useTimelineStore.getState().getPositionForIndex(99)).toBe(0);
  });
});
