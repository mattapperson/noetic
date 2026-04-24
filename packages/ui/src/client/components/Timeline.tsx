/**
 * Timeline component
 * Draggable timeline with event markers showing executed steps
 * Spacing represents wall clock time, color-coded by step kind
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getStepKindColor } from '../lib/time-travel';
import {
  useIsDragging,
  usePlayheadPosition,
  useSelectedMarker,
  useTimelineMarkers,
  useTimelineStore,
} from '../stores';
import type { TimelineMarker } from '../stores/timelineStore';

interface TimelineProps {
  /** Additional CSS class names */
  className?: string;
  /** Height of the timeline track in pixels (default: 48) */
  height?: number;
  /** Width of the timeline track (default: '100%') */
  width?: string | number;
  /** Show marker tooltips on hover (default: true) */
  showTooltips?: boolean;
  /** Callback when a marker is clicked */
  onMarkerClick?: (marker: TimelineMarker) => void;
  /** Callback when playhead position changes (during drag) */
  onPositionChange?: (position: number) => void;
  /** Callback when drag ends */
  onDragEnd?: (position: number) => void;
}

interface MarkerTooltipProps {
  marker: TimelineMarker;
  x: number;
  y: number;
  visible: boolean;
  containerWidth: number;
}

const TOOLTIP_WIDTH_ESTIMATE = 120;
const CARET_SIZE = 6;

const MarkerTooltip: React.FC<MarkerTooltipProps> = ({ marker, x, y, visible, containerWidth }) => {
  if (!visible) {
    return null;
  }

  // Position tooltip above the marker with edge-aware adjustment
  const tooltipY = y - 8;
  const halfTooltip = TOOLTIP_WIDTH_ESTIMATE / 2;

  // Clamp left so the tooltip stays within the container
  let tooltipLeft = x;
  let caretOffset = 0;
  if (x - halfTooltip < 8) {
    tooltipLeft = halfTooltip + 8;
    caretOffset = x - tooltipLeft;
  } else if (containerWidth > 0 && x + halfTooltip > containerWidth - 8) {
    tooltipLeft = containerWidth - halfTooltip - 8;
    caretOffset = x - tooltipLeft;
  }

  return (
    <div
      className="absolute z-50 pointer-events-none"
      style={{
        left: tooltipLeft,
        bottom: `calc(100% - ${tooltipY}px)`,
        transform: 'translateX(-50%)',
      }}
    >
      <div className="px-2.5 py-1.5 text-xs bg-slate-800 text-slate-200 rounded shadow-lg border border-slate-700 whitespace-nowrap">
        <div className="font-medium">{marker.stepKind.toUpperCase()}</div>
        <div className="text-slate-400">{marker.duration}ms</div>
      </div>
      {/* Caret pointing down toward the marker */}
      <div
        className="mx-auto"
        style={{
          width: 0,
          height: 0,
          borderLeft: `${CARET_SIZE}px solid transparent`,
          borderRight: `${CARET_SIZE}px solid transparent`,
          borderTop: `${CARET_SIZE}px solid #1e293b`,
          marginLeft: `calc(50% + ${caretOffset}px - ${CARET_SIZE}px)`,
        }}
      />
    </div>
  );
};

export const Timeline: React.FC<TimelineProps> = ({
  className = '',
  height = 48,
  width = '100%',
  showTooltips = true,
  onMarkerClick,
  onPositionChange,
  onDragEnd,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const markers = useTimelineMarkers();
  const playheadPosition = usePlayheadPosition();
  const isDragging = useIsDragging();
  const selectedMarkerId = useSelectedMarker();
  const {
    startDrag,
    updateDrag,
    endDrag,
    setPlayheadPosition,
    selectMarker,
    hoverMarker,
    snapToNearestMarker,
  } = useTimelineStore();

  const [tooltip, setTooltip] = useState<{
    marker: TimelineMarker | null;
    x: number;
    y: number;
    visible: boolean;
  }>({
    marker: null,
    x: 0,
    y: 0,
    visible: false,
  });

  // Convert mouse/touch position to timeline position (0.0 to 1.0)
  const getPositionFromEvent = useCallback((clientX: number): number => {
    if (!containerRef.current) {
      return 0;
    }
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.max(0, Math.min(1, x / rect.width));
  }, []);

  // Handle mouse/touch start
  const handleStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const position = getPositionFromEvent(clientX);
      startDrag(position);

      // Check if clicked on a marker
      const clickedMarker = markers.find((m) => Math.abs(m.position - position) < 0.02);
      if (clickedMarker) {
        selectMarker(clickedMarker.id);
        setPlayheadPosition(clickedMarker.position);
        onMarkerClick?.(clickedMarker);
      } else {
        setPlayheadPosition(position);
      }
    },
    [
      getPositionFromEvent,
      markers,
      selectMarker,
      setPlayheadPosition,
      startDrag,
      onMarkerClick,
    ],
  );

  // Handle mouse/touch move
  const handleMove = useCallback(
    (e: MouseEvent | TouchEvent) => {
      if (!isDragging) {
        return;
      }

      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const position = getPositionFromEvent(clientX);
      updateDrag(position);
      onPositionChange?.(position);
    },
    [
      isDragging,
      getPositionFromEvent,
      updateDrag,
      onPositionChange,
    ],
  );

  // Handle mouse/touch end
  const handleEnd = useCallback(() => {
    if (isDragging) {
      endDrag();
      snapToNearestMarker();
      onDragEnd?.(playheadPosition);
    }
  }, [
    isDragging,
    endDrag,
    snapToNearestMarker,
    playheadPosition,
    onDragEnd,
  ]);

  // Add/remove global event listeners for drag
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleEnd);
      window.addEventListener('touchmove', handleMove);
      window.addEventListener('touchend', handleEnd);

      return () => {
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleEnd);
        window.removeEventListener('touchmove', handleMove);
        window.removeEventListener('touchend', handleEnd);
      };
    }
  }, [
    isDragging,
    handleMove,
    handleEnd,
  ]);

  // Handle marker hover
  const handleMarkerMouseEnter = useCallback(
    (marker: TimelineMarker, e: React.MouseEvent) => {
      hoverMarker(marker.id);
      if (showTooltips && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setTooltip({
          marker,
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          visible: true,
        });
      }
    },
    [
      hoverMarker,
      showTooltips,
    ],
  );

  const handleMarkerMouseLeave = useCallback(() => {
    hoverMarker(null);
    setTooltip((prev) => ({
      ...prev,
      visible: false,
    }));
  }, [
    hoverMarker,
  ]);

  // Handle keyboard interactions for markers
  const handleMarkerKeyDown = useCallback(
    (marker: TimelineMarker, e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectMarker(marker.id);
        setPlayheadPosition(marker.position);
        onMarkerClick?.(marker);
      }
    },
    [
      selectMarker,
      setPlayheadPosition,
      onMarkerClick,
    ],
  );

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      style={{
        width,
        height,
      }}
      onMouseDown={handleStart}
      onTouchStart={handleStart}
      role="slider"
      aria-label="Timeline scrubber"
      aria-valuenow={Math.round(playheadPosition * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${Math.round(playheadPosition * 100)}% through execution`}
      tabIndex={0}
    >
      {/* Timeline track background */}
      <div
        className="absolute inset-0 bg-slate-800 rounded-md overflow-hidden cursor-crosshair"
        style={{
          height,
        }}
      >
        {/* Track line */}
        <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-slate-600 -translate-y-1/2" />

        {/* Progress bar (from start to playhead) */}
        <div
          className={`absolute top-1/2 left-0 h-0.5 bg-blue-500 -translate-y-1/2 ${isDragging ? '' : 'transition-all duration-75'}`}
          style={{
            width: `${playheadPosition * 100}%`,
          }}
        />

        {/* Event markers */}
        {markers.map((marker) => {
          const isSelected = marker.id === selectedMarkerId;
          const isPast = marker.position < playheadPosition;
          const isFuture = marker.position > playheadPosition;
          const color = getStepKindColor(marker.stepKind);

          // Height based on depth (taller for deeper nesting)
          const markerHeight = Math.min(32, 12 + marker.depth * 4);
          const markerVisualWidth = isSelected ? 4 : 3;
          // Wider invisible hit area for easier clicking
          const hitAreaWidth = 16;

          return (
            <button
              key={marker.id}
              type="button"
              className={`
                absolute top-1/2 -translate-x-1/2 -translate-y-1/2
                cursor-pointer
                transition-all duration-150
                focus:outline-none
                group
              `}
              style={{
                left: `${marker.position * 100}%`,
                width: hitAreaWidth,
                height: markerHeight + 8,
                background: 'transparent',
              }}
              onMouseEnter={(e) => handleMarkerMouseEnter(marker, e)}
              onMouseLeave={handleMarkerMouseLeave}
              onClick={(e) => {
                e.stopPropagation();
                selectMarker(marker.id);
                setPlayheadPosition(marker.position);
                onMarkerClick?.(marker);
              }}
              onKeyDown={(e) => handleMarkerKeyDown(marker, e)}
              aria-label={`${marker.stepKind} step at position ${Math.round(marker.position * 100)}%`}
            >
              {/* Visual marker (narrow) */}
              <div
                className={`
                  mx-auto rounded-sm
                  transition-all duration-150
                  group-hover:scale-x-150
                  ${isSelected ? 'ring-2 ring-blue-400 ring-offset-1 ring-offset-slate-800' : ''}
                  ${isSelected ? '' : 'group-focus-visible:ring-2 group-focus-visible:ring-blue-400 group-focus-visible:ring-offset-1 group-focus-visible:ring-offset-slate-800'}
                `}
                style={{
                  width: markerVisualWidth,
                  height: markerHeight,
                  backgroundColor: isPast ? color : isFuture ? `${color}60` : color,
                  opacity: isFuture ? 0.5 : 1,
                }}
              />
            </button>
          );
        })}

        {/* Playhead */}
        <div
          className={`
            absolute top-0 bottom-0 w-0.5
            bg-blue-500
            ${isDragging ? 'scale-125 bg-blue-400' : 'transition-all duration-75'}
          `}
          style={{
            left: `${playheadPosition * 100}%`,
            boxShadow: isDragging
              ? '0 0 12px rgba(59, 130, 246, 0.8), 0 0 24px rgba(59, 130, 246, 0.4)'
              : '0 0 8px rgba(59, 130, 246, 0.6)',
          }}
        >
          {/* Playhead handle (visible when dragging) */}
          <div
            className={`
              absolute -top-1 left-1/2 -translate-x-1/2
              w-3 h-3 rounded-full bg-blue-500
              transition-all duration-150
              ${isDragging ? 'scale-150 bg-blue-400' : 'opacity-0'}
            `}
          />
          <div
            className={`
              absolute -bottom-1 left-1/2 -translate-x-1/2
              w-3 h-3 rounded-full bg-blue-500
              transition-all duration-150
              ${isDragging ? 'scale-150 bg-blue-400' : 'opacity-0'}
            `}
          />
        </div>
      </div>

      {/* Tooltip */}
      {showTooltips && tooltip.visible && tooltip.marker && (
        <MarkerTooltip
          marker={tooltip.marker}
          x={tooltip.x}
          y={tooltip.y}
          visible={tooltip.visible}
          containerWidth={containerRef.current?.getBoundingClientRect().width ?? 0}
        />
      )}
    </div>
  );
};

export default Timeline;
