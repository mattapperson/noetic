/**
 * PlaybackBar component
 * Bottom playback bar combining all controls:
 * - Connection indicator
 * - Position display
 * - Transport controls
 * - Timeline scrubber
 * - Playback speed
 */

import type React from 'react';
import { useCallback, useEffect } from 'react';
import { formatStepPosition } from '../lib/time-travel';
import { usePlaybackStore, useTimelineStore } from '../stores';
import { ConnectionIndicator } from './ConnectionIndicator';
import { PlaybackSpeedControl } from './PlaybackSpeed';
import { Timeline } from './Timeline';
import { TransportControls } from './TransportControls';

interface PlaybackBarProps {
  /** Additional CSS class names */
  className?: string;
  /** Execution nodes for timeline markers */
  nodes?: Map<string, import('../types').ExecutionNode>;
  /** Callback when timeline position changes */
  onTimelineChange?: (stepIndex: number, nodeId: string) => void;
}

export const PlaybackBar: React.FC<PlaybackBarProps> = ({
  className = '',
  nodes = new Map(),
  onTimelineChange,
}) => {
  const { currentStepIndex, totalSteps, setTotalSteps, jumpToStep } = usePlaybackStore();

  const { markers, setPlayheadToMarker, selectMarker } = useTimelineStore();

  // Update total steps when nodes change
  useEffect(() => {
    setTotalSteps(nodes.size);
    // Initialize timeline markers
    const nodeArray = Array.from(nodes.values());
    useTimelineStore.getState().setMarkers(nodeArray);
  }, [
    nodes,
    setTotalSteps,
  ]);

  // Sync playback step index with timeline
  useEffect(() => {
    const marker = markers[currentStepIndex];
    if (marker) {
      setPlayheadToMarker(marker.id);
      selectMarker(marker.id);
    }
  }, [
    currentStepIndex,
    markers,
    setPlayheadToMarker,
    selectMarker,
  ]);

  // Handle timeline position change during drag
  const handleTimelineChange = useCallback(
    (position: number) => {
      // Find nearest marker to position
      const { getNearestMarker } = useTimelineStore.getState();
      const nearest = getNearestMarker(position);
      if (nearest) {
        const index = markers.findIndex((m) => m.id === nearest.id);
        if (index !== -1 && index !== currentStepIndex) {
          jumpToStep(index);
          onTimelineChange?.(index, nearest.nodeId);
        }
      }
    },
    [
      markers,
      currentStepIndex,
      jumpToStep,
      onTimelineChange,
    ],
  );

  // Handle timeline drag end
  const handleTimelineDragEnd = useCallback(
    (position: number) => {
      const { getNearestMarker } = useTimelineStore.getState();
      const nearest = getNearestMarker(position);
      if (nearest) {
        const index = markers.findIndex((m) => m.id === nearest.id);
        if (index !== -1) {
          jumpToStep(index);
          onTimelineChange?.(index, nearest.nodeId);
        }
      }
    },
    [
      markers,
      jumpToStep,
      onTimelineChange,
    ],
  );

  // Handle marker click
  const handleMarkerClick = useCallback(
    (marker: import('../stores/timelineStore').TimelineMarker) => {
      const index = markers.findIndex((m) => m.id === marker.id);
      if (index !== -1) {
        jumpToStep(index);
        onTimelineChange?.(index, marker.nodeId);
      }
    },
    [
      markers,
      jumpToStep,
      onTimelineChange,
    ],
  );

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Space: toggle play/pause
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        usePlaybackStore.getState().togglePlayPause();
      }
      // Left arrow: step back
      if (e.code === 'ArrowLeft' && !e.shiftKey) {
        e.preventDefault();
        usePlaybackStore.getState().stepBackward();
      }
      // Right arrow: step forward
      if (e.code === 'ArrowRight' && !e.shiftKey) {
        e.preventDefault();
        usePlaybackStore.getState().stepForward();
      }
      // Home: jump to first
      if (e.code === 'Home') {
        e.preventDefault();
        usePlaybackStore.getState().jumpToFirst();
      }
      // End: jump to last
      if (e.code === 'End') {
        e.preventDefault();
        usePlaybackStore.getState().jumpToLast();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const positionText =
    totalSteps > 0 ? formatStepPosition(currentStepIndex, totalSteps) : 'No steps';

  return (
    <div
      className={`
        flex flex-col gap-2 p-3
        bg-slate-900 border-t border-slate-800
        ${className}
      `}
    >
      {/* Top row: Transport controls, position display, connection, speed */}
      <div className="flex items-center justify-between gap-4">
        {/* Left: Transport controls */}
        <TransportControls buttonSize={28} />

        {/* Center: Position display */}
        <div className="flex flex-col items-center">
          <span className="text-sm font-medium text-slate-200">{positionText}</span>
          <span className="text-xs text-slate-500">
            {totalSteps > 0 ? `${Math.round(((currentStepIndex + 1) / totalSteps) * 100)}%` : '-'}
          </span>
        </div>

        {/* Right: Connection and speed */}
        <div className="flex items-center gap-4">
          <ConnectionIndicator showLabel={false} dotSize={8} />
          <PlaybackSpeedControl showLiveButton={true} />
        </div>
      </div>

      {/* Bottom row: Timeline */}
      <Timeline
        height={40}
        showTooltips={true}
        onPositionChange={handleTimelineChange}
        onDragEnd={handleTimelineDragEnd}
        onMarkerClick={handleMarkerClick}
      />
    </div>
  );
};

export default PlaybackBar;
