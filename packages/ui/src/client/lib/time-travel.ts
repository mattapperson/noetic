/**
 * Time-travel scrubbing logic for Noetic UI
 * Handles time-travel navigation through execution traces
 */

import type { StepKind } from '../../shared/protocol';
import type { TimelineMarker } from '../stores/timelineStore';
import type { ExecutionNode } from '../types';

export interface ScrubState {
  /** Current node at scrub position */
  currentNode: ExecutionNode | null;
  /** Current step index (0-based) */
  stepIndex: number;
  /** Progress through execution (0.0 to 1.0) */
  progress: number;
  /** Current timestamp in execution */
  timestamp: number;
}

export interface ScrubOptions {
  /** Whether to snap to the nearest step or allow free scrubbing */
  snapToSteps: boolean;
  /** Threshold for snapping (0.0 to 1.0 as percentage of timeline) */
  snapThreshold: number;
}

export const DEFAULT_SCRUB_OPTIONS: ScrubOptions = {
  snapToSteps: true,
  snapThreshold: 0.02, // 2% of timeline
};

/**
 * Options for scrub calculation
 */
export interface CalculateScrubStateOptions {
  /** Position on timeline (0.0 to 1.0) */
  position: number;
  /** Array of timeline markers */
  markers: TimelineMarker[];
  /** Map of node IDs to execution nodes */
  nodes: Map<string, ExecutionNode>;
  /** Scrub behavior options */
  options?: Partial<ScrubOptions>;
}

/**
 * Calculate scrub state for a given position on the timeline
 * This is purely observational - no code is re-executed
 */
export function calculateScrubState({
  position,
  markers,
  nodes,
  options = {},
}: CalculateScrubStateOptions): ScrubState {
  const opts = {
    ...DEFAULT_SCRUB_OPTIONS,
    ...options,
  };

  if (markers.length === 0) {
    return {
      currentNode: null,
      stepIndex: 0,
      progress: position,
      timestamp: 0,
    };
  }

  // Find the nearest marker
  let nearestMarker: TimelineMarker | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearestIndex = 0;

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const distance = Math.abs(marker.position - position);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestMarker = marker;
      nearestIndex = i;
    }
  }

  // If within snap threshold, use the nearest marker
  if (opts.snapToSteps && nearestMarker && nearestDistance <= opts.snapThreshold) {
    const node = nodes.get(nearestMarker.nodeId) ?? null;
    return {
      currentNode: node,
      stepIndex: nearestIndex,
      progress: nearestMarker.position,
      timestamp: nearestMarker.timestamp,
    };
  }

  // Find markers before and after position for interpolation
  let beforeIndex = -1;
  let afterIndex = -1;

  for (let i = 0; i < markers.length; i++) {
    if (markers[i].position <= position) {
      beforeIndex = i;
    }
    if (markers[i].position >= position && afterIndex === -1) {
      afterIndex = i;
      break;
    }
  }

  // Use the last marker before current position as the current step
  const currentIndex = beforeIndex >= 0 ? beforeIndex : 0;
  const currentMarker = markers[currentIndex];
  const currentNode = nodes.get(currentMarker?.nodeId ?? '') ?? null;

  // Calculate timestamp based on interpolation between markers
  let timestamp: number;
  if (beforeIndex >= 0 && afterIndex >= 0 && beforeIndex !== afterIndex) {
    const before = markers[beforeIndex];
    const after = markers[afterIndex];
    const segmentProgress = (position - before.position) / (after.position - before.position);
    timestamp = before.timestamp + (after.timestamp - before.timestamp) * segmentProgress;
  } else {
    timestamp = currentMarker?.timestamp ?? 0;
  }

  return {
    currentNode,
    stepIndex: currentIndex,
    progress: position,
    timestamp,
  };
}

/**
 * Visual state for a marker at a given scrub position
 */
export interface MarkerVisualState {
  marker: TimelineMarker;
  /** Whether this marker is in the past (already executed) */
  isPast: boolean;
  /** Whether this marker is the current position */
  isCurrent: boolean;
  /** Whether this marker is in the future (not yet executed) */
  isFuture: boolean;
  /** Distance from playhead (0.0 to 1.0, negative if past) */
  distanceFromPlayhead: number;
}

/**
 * Options for getting marker visual states
 */
export interface GetMarkerVisualStatesOptions {
  /** Current playhead position (0.0 to 1.0) */
  playheadPosition: number;
  /** Array of timeline markers */
  markers: TimelineMarker[];
  /** Threshold for determining current marker (default 0.01) */
  threshold?: number;
}

/**
 * Get the visual state for all markers at a given scrub position
 * This determines how markers should be rendered (past, current, future)
 */
export function getMarkerVisualStates({
  playheadPosition,
  markers,
  threshold = 0.01,
}: GetMarkerVisualStatesOptions): MarkerVisualState[] {
  return markers.map((marker) => {
    const distance = marker.position - playheadPosition;
    const isCurrent = Math.abs(distance) <= threshold;

    return {
      marker,
      isPast: distance < -threshold,
      isCurrent,
      isFuture: distance > threshold,
      distanceFromPlayhead: distance,
    };
  });
}

/**
 * Navigate to next/previous step in execution
 */
export function navigateStep(
  direction: 'forward' | 'backward',
  currentIndex: number,
  markers: TimelineMarker[],
): {
  newIndex: number;
  newPosition: number;
} | null {
  if (markers.length === 0) {
    return null;
  }

  let newIndex: number;
  if (direction === 'forward') {
    newIndex = Math.min(currentIndex + 1, markers.length - 1);
  } else {
    newIndex = Math.max(currentIndex - 1, 0);
  }

  const marker = markers[newIndex];
  if (!marker) {
    return null;
  }

  return {
    newIndex,
    newPosition: marker.position,
  };
}

/**
 * Options for jumping to a specific step kind
 */
export interface JumpToStepKindOptions {
  /** The step kind to jump to */
  kind: StepKind;
  /** Current marker index */
  currentIndex: number;
  /** Array of timeline markers */
  markers: TimelineMarker[];
  /** Direction to search */
  direction: 'forward' | 'backward';
}

/**
 * Jump to a specific step kind in the execution
 */
export function jumpToStepKind({ kind, currentIndex, markers, direction }: JumpToStepKindOptions): {
  newIndex: number;
  newPosition: number;
} | null {
  if (direction === 'forward') {
    for (let i = currentIndex + 1; i < markers.length; i++) {
      if (markers[i].stepKind === kind) {
        return {
          newIndex: i,
          newPosition: markers[i].position,
        };
      }
    }
  } else {
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (markers[i].stepKind === kind) {
        return {
          newIndex: i,
          newPosition: markers[i].position,
        };
      }
    }
  }
  return null;
}

/**
 * Get color for a step kind (matching the spec colors)
 */
export function getStepKindColor(kind: StepKind): string {
  const colors: Record<StepKind, string> = {
    llm: '#8b5cf6', // Purple
    tool: '#f97316', // Orange
    run: '#06b6d4', // Cyan
    branch: '#eab308', // Yellow
    fork: '#ec4899', // Pink
    spawn: '#6366f1', // Indigo
    loop: '#14b8a6', // Teal
  };
  return colors[kind] ?? '#6b7280';
}

/**
 * Format step position for display (e.g., "Step 9 / 24")
 */
export function formatStepPosition(currentIndex: number, totalSteps: number): string {
  const stepNumber = currentIndex + 1;
  return `Step ${stepNumber} / ${totalSteps}`;
}

/**
 * Format playback time for display (e.g., "0:45:23")
 */
export function formatPlaybackTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
