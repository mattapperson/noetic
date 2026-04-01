'use client';

/**
 * Execution store - ephemeral UI state for execution viewing
 * Does NOT duplicate agent/run data (use agentStore for that)
 * Focuses on UI state: selections, playback, navigation
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { ExecutionNode, ExecutionTrace } from '../../shared/protocol';

interface ExecutionState {
  // Trace data cache (ephemeral - for performance)
  traces: Map<string, ExecutionTrace>;
  nodes: Map<string, ExecutionNode>;

  // Playback state (ephemeral)
  currentTimelinePosition: number;
  isPlaying: boolean;
  playbackSpeed: number;

  // Trace cache management
  setTrace: (traceId: string, trace: ExecutionTrace) => void;
  setNode: (nodeId: string, node: ExecutionNode) => void;
  updateNode: (nodeId: string, updates: Partial<ExecutionNode>) => void;
  clearTraceCache: () => void;

  // Playback
  setTimelinePosition: (position: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setPlaybackSpeed: (speed: number) => void;
}

export const useExecutionStore = create<ExecutionState>()(
  subscribeWithSelector((set) => ({
    // Initial state - all ephemeral
    traces: new Map(),
    nodes: new Map(),

    currentTimelinePosition: 0,
    isPlaying: false,
    playbackSpeed: 1,

    // Trace cache - ephemeral, cleared periodically
    setTrace: (traceId, trace) => {
      set((state) => {
        const newTraces = new Map(state.traces);
        newTraces.set(traceId, trace);

        // Also populate nodes from the trace so timeline and inspector work
        const newNodes = new Map(state.nodes);
        for (const [nodeId, node] of trace.nodes) {
          newNodes.set(nodeId, node);
        }

        return {
          traces: newTraces,
          nodes: newNodes,
        };
      });
    },

    setNode: (nodeId, node) => {
      set((state) => {
        const newNodes = new Map(state.nodes);
        newNodes.set(nodeId, node);
        return {
          nodes: newNodes,
        };
      });
    },

    updateNode: (nodeId, updates) => {
      set((state) => {
        const node = state.nodes.get(nodeId);
        if (!node) return state;

        const newNodes = new Map(state.nodes);
        const updatedNode = {
          ...node,
          ...updates,
        };
        newNodes.set(nodeId, updatedNode);

        return {
          nodes: newNodes,
        };
      });
    },

    clearTraceCache: () => {
      set({
        traces: new Map(),
        nodes: new Map(),
      });
    },

    // Playback
    setTimelinePosition: (position) => {
      set({
        currentTimelinePosition: Math.max(0, Math.min(1, position)),
      });
    },

    setIsPlaying: (playing) => {
      set({
        isPlaying: playing,
      });
    },

    setPlaybackSpeed: (speed) => {
      set({
        playbackSpeed: Math.max(0.5, Math.min(10, speed)),
      });
    },
  })),
);
