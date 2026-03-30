/**
 * Timeline store for managing timeline data and scrubbing
 * Handles event markers, playhead position, and time-travel functionality
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { ExecutionNode, StepKind } from '../types';

export interface TimelineMarker {
  id: string;
  nodeId: string;
  stepKind: StepKind;
  timestamp: number;
  duration: number;
  depth: number;
  status: 'completed' | 'error' | 'running' | 'paused';
  position: number; // 0.0 to 1.0 on timeline
}

export interface TimelineState {
  // Markers
  markers: TimelineMarker[];

  // Playhead
  playheadPosition: number; // 0.0 to 1.0
  isDragging: boolean;
  dragStartPosition: number | null;

  // Time range
  startTime: number;
  endTime: number;
  totalDuration: number;

  // Selected marker
  selectedMarkerId: string | null;
  hoveredMarkerId: string | null;

  // View state
  zoom: number; // 1.0 = default
  scrollOffset: number;

  // Actions
  setMarkers: (nodes: ExecutionNode[]) => void;
  updateMarker: (markerId: string, updates: Partial<TimelineMarker>) => void;
  addMarker: (node: ExecutionNode) => void;

  // Playhead
  setPlayheadPosition: (position: number) => void;
  setPlayheadToMarker: (markerId: string) => void;
  startDrag: (position: number) => void;
  updateDrag: (position: number) => void;
  endDrag: () => void;
  snapToNearestMarker: () => void;

  // Selection
  selectMarker: (markerId: string | null) => void;
  hoverMarker: (markerId: string | null) => void;

  // View
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitToView: () => void;
  setScrollOffset: (offset: number) => void;

  // Navigation
  getMarkerAtPosition: (position: number) => TimelineMarker | null;
  getNearestMarker: (position: number) => TimelineMarker | null;
  getMarkerByIndex: (index: number) => TimelineMarker | null;
  getMarkerIndex: (markerId: string) => number;
  getPositionForIndex: (index: number) => number;
}

// Step kind colors (matching spec)
export const STEP_KIND_COLORS: Record<StepKind, string> = {
  llm: '#8b5cf6', // Purple
  tool: '#f97316', // Orange
  run: '#06b6d4', // Cyan
  branch: '#eab308', // Yellow
  fork: '#ec4899', // Pink
  spawn: '#6366f1', // Indigo
  loop: '#14b8a6', // Teal
};

// Calculate marker position based on wall clock time
function calculateMarkerPosition(
  timestamp: number,
  startTime: number,
  totalDuration: number,
): number {
  if (totalDuration === 0) {
    return 0;
  }
  const offset = timestamp - startTime;
  return Math.max(0, Math.min(1, offset / totalDuration));
}

export const useTimelineStore = create<TimelineState>()(
  subscribeWithSelector((set, get) => ({
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

    setMarkers: (nodes: ExecutionNode[]) => {
      if (nodes.length === 0) {
        set({
          markers: [],
          startTime: 0,
          endTime: 0,
          totalDuration: 0,
          playheadPosition: 0,
        });
        return;
      }

      // Sort by start time
      const sortedNodes = [
        ...nodes,
      ].sort((a, b) => a.startTime - b.startTime);

      const startTime = sortedNodes[0]?.startTime ?? 0;
      const endTime =
        sortedNodes[sortedNodes.length - 1]?.endTime ??
        sortedNodes[sortedNodes.length - 1]?.startTime ??
        startTime;
      const totalDuration = endTime - startTime;

      const markers: TimelineMarker[] = sortedNodes.map((node) => ({
        id: `marker-${node.id}`,
        nodeId: node.id,
        stepKind: node.kind,
        timestamp: node.startTime,
        duration: node.durationMs ?? 0,
        depth: node.depth,
        status:
          node.status === 'error'
            ? 'error'
            : node.status === 'paused'
              ? 'paused'
              : node.status === 'running'
                ? 'running'
                : 'completed',
        position: calculateMarkerPosition(node.startTime, startTime, totalDuration),
      }));

      set({
        markers,
        startTime,
        endTime,
        totalDuration,
      });
    },

    updateMarker: (markerId: string, updates: Partial<TimelineMarker>) => {
      set((state) => ({
        markers: state.markers.map((m) =>
          m.id === markerId
            ? {
                ...m,
                ...updates,
              }
            : m,
        ),
      }));
    },

    addMarker: (node: ExecutionNode) => {
      const { startTime, totalDuration, markers } = get();

      const position = calculateMarkerPosition(node.startTime, startTime, totalDuration);

      const newMarker: TimelineMarker = {
        id: `marker-${node.id}`,
        nodeId: node.id,
        stepKind: node.kind,
        timestamp: node.startTime,
        duration: node.durationMs ?? 0,
        depth: node.depth,
        status:
          node.status === 'error'
            ? 'error'
            : node.status === 'paused'
              ? 'paused'
              : node.status === 'running'
                ? 'running'
                : 'completed',
        position,
      };

      // Insert in sorted order
      const newMarkers = [
        ...markers,
        newMarker,
      ].sort((a, b) => a.timestamp - b.timestamp);

      set({
        markers: newMarkers,
      });
    },

    setPlayheadPosition: (position: number) => {
      const clampedPosition = Math.max(0, Math.min(1, position));
      set({
        playheadPosition: clampedPosition,
      });
    },

    setPlayheadToMarker: (markerId: string) => {
      const marker = get().markers.find((m) => m.id === markerId);
      if (marker) {
        set({
          playheadPosition: marker.position,
          selectedMarkerId: markerId,
        });
      }
    },

    startDrag: (position: number) => {
      set({
        isDragging: true,
        dragStartPosition: position,
        playheadPosition: position,
      });
    },

    updateDrag: (position: number) => {
      const clampedPosition = Math.max(0, Math.min(1, position));
      set({
        playheadPosition: clampedPosition,
      });
    },

    endDrag: () => {
      set({
        isDragging: false,
        dragStartPosition: null,
      });
      // Snap to nearest marker after drag ends
      get().snapToNearestMarker();
    },

    snapToNearestMarker: () => {
      const { playheadPosition } = get();
      const nearest = get().getNearestMarker(playheadPosition);
      if (nearest) {
        set({
          playheadPosition: nearest.position,
          selectedMarkerId: nearest.id,
        });
      }
    },

    selectMarker: (markerId: string | null) => {
      set({
        selectedMarkerId: markerId,
      });
      if (markerId) {
        const marker = get().markers.find((m) => m.id === markerId);
        if (marker) {
          set({
            playheadPosition: marker.position,
          });
        }
      }
    },

    hoverMarker: (markerId: string | null) => {
      set({
        hoveredMarkerId: markerId,
      });
    },

    setZoom: (zoom: number) => {
      set({
        zoom: Math.max(0.1, Math.min(10, zoom)),
      });
    },

    zoomIn: () => {
      set((state) => ({
        zoom: Math.min(10, state.zoom * 1.2),
      }));
    },

    zoomOut: () => {
      set((state) => ({
        zoom: Math.max(0.1, state.zoom / 1.2),
      }));
    },

    fitToView: () => {
      set({
        zoom: 1,
        scrollOffset: 0,
      });
    },

    setScrollOffset: (offset: number) => {
      set({
        scrollOffset: Math.max(0, offset),
      });
    },

    getMarkerAtPosition: (position: number) => {
      const { markers } = get();
      // Find marker closest to position within a small threshold
      const threshold = 0.02; // 2% of timeline width
      return (
        markers.find((m) => {
          return Math.abs(m.position - position) < threshold;
        }) ?? null
      );
    },

    getNearestMarker: (position: number) => {
      const { markers } = get();
      if (markers.length === 0) {
        return null;
      }

      let nearest = markers[0];
      let minDistance = Math.abs(nearest.position - position);

      for (const marker of markers) {
        const distance = Math.abs(marker.position - position);
        if (distance < minDistance) {
          minDistance = distance;
          nearest = marker;
        }
      }

      return nearest;
    },

    getMarkerByIndex: (index: number) => {
      const { markers } = get();
      if (index < 0 || index >= markers.length) {
        return null;
      }
      return markers[index] ?? null;
    },

    getMarkerIndex: (markerId: string) => {
      return get().markers.findIndex((m) => {
        return m.id === markerId;
      });
    },

    getPositionForIndex: (index: number) => {
      const marker = get().getMarkerByIndex(index);
      return marker?.position ?? 0;
    },
  })),
);

// Selector hooks
export const useTimelineMarkers = () => useTimelineStore((state) => state.markers);
export const usePlayheadPosition = () => useTimelineStore((state) => state.playheadPosition);
export const useIsDragging = () => useTimelineStore((state) => state.isDragging);
export const useSelectedMarker = () => useTimelineStore((state) => state.selectedMarkerId);
export const useHoveredMarker = () => useTimelineStore((state) => state.hoveredMarkerId);
export const useTimelineZoom = () => useTimelineStore((state) => state.zoom);
