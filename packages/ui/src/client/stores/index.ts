/**
 * Store exports for Noetic UI client
 */

// Re-export connection hooks from the hook file where they're actually implemented
export { useConnectionStatus, useReconnectAttempt } from '../hooks/useConnection';
export {
  type PlaybackSpeed,
  type PlaybackState,
  useCurrentStepIndex,
  useIsAtEnd,
  useIsAtStart,
  usePlaybackSpeed,
  usePlaybackState,
  usePlaybackStore,
  useTotalSteps,
} from './playbackStore';
export {
  STEP_KIND_COLORS,
  type TimelineMarker,
  useHoveredMarker,
  useIsDragging,
  usePlayheadPosition,
  useSelectedMarker,
  useTimelineMarkers,
  useTimelineStore,
  useTimelineZoom,
} from './timelineStore';
export {
  type ConnectionStatus,
  registerMessageHandler,
  useWebSocketStore,
} from './websocket';
