/**
 * TransportControls component
 * Play/pause/step forward/step backward/jump to first/jump to last buttons
 */

import type React from 'react';
import { useIsAtEnd, useIsAtStart, usePlaybackState, usePlaybackStore } from '../stores';

interface TransportControlsProps {
  /** Additional CSS class names */
  className?: string;
  /** Button size in pixels (default: 32) */
  buttonSize?: number;
}

// SVG Icons as components for better control
const FirstIcon: React.FC<{
  size: number;
}> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <title>First step</title>
    <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
  </svg>
);

const StepBackIcon: React.FC<{
  size: number;
}> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <title>Step back</title>
    <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" transform="rotate(180 12 12)" />
    <rect x="18" y="6" width="2" height="12" />
  </svg>
);

const PlayIcon: React.FC<{
  size: number;
}> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <title>Play</title>
    <path d="M8 5v14l11-7z" />
  </svg>
);

const PauseIcon: React.FC<{
  size: number;
}> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <title>Pause</title>
    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
  </svg>
);

const StepForwardIcon: React.FC<{
  size: number;
}> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <title>Step forward</title>
    <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
    <rect x="18" y="6" width="2" height="12" />
  </svg>
);

const LastIcon: React.FC<{
  size: number;
}> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <title>Last step</title>
    <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" transform="rotate(180 12 12)" />
  </svg>
);

export const TransportControls: React.FC<TransportControlsProps> = ({
  className = '',
  buttonSize = 32,
}) => {
  const state = usePlaybackState();
  const isAtStart = useIsAtStart();
  const isAtEnd = useIsAtEnd();
  const { togglePlayPause, stepBackward, stepForward, jumpToFirst, jumpToLast } =
    usePlaybackStore();

  const isPlaying = state === 'playing';
  const isLive = state === 'live';

  const buttonClass = `
    flex items-center justify-center
    rounded-md
    transition-all duration-150
    focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
    disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent
    hover:bg-slate-700 active:scale-95
  `;

  const iconColor = 'text-slate-300';
  const playColor = isPlaying || isLive ? 'text-emerald-400' : 'text-slate-300';

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {/* Jump to First */}
      <button
        type="button"
        onClick={jumpToFirst}
        disabled={isAtStart}
        className={`${buttonClass} ${iconColor}`}
        title="Jump to first step (⏮)"
        aria-label="Jump to first step"
      >
        <FirstIcon size={buttonSize} />
      </button>

      {/* Step Backward */}
      <button
        type="button"
        onClick={stepBackward}
        disabled={isAtStart}
        className={`${buttonClass} ${iconColor}`}
        title="Step backward (⏴)"
        aria-label="Step backward"
      >
        <StepBackIcon size={buttonSize} />
      </button>

      {/* Play/Pause */}
      <button
        type="button"
        onClick={togglePlayPause}
        className={`${buttonClass} ${playColor}`}
        title={isPlaying ? 'Pause (⏯)' : isLive ? 'Live mode active' : 'Play (⏯)'}
        aria-label={isPlaying ? 'Pause playback' : 'Start playback'}
      >
        {isPlaying ? <PauseIcon size={buttonSize} /> : <PlayIcon size={buttonSize} />}
      </button>

      {/* Step Forward */}
      <button
        type="button"
        onClick={stepForward}
        disabled={isAtEnd}
        className={`${buttonClass} ${iconColor}`}
        title="Step forward (⏵)"
        aria-label="Step forward"
      >
        <StepForwardIcon size={buttonSize} />
      </button>

      {/* Jump to Last */}
      <button
        type="button"
        onClick={jumpToLast}
        disabled={isAtEnd}
        className={`${buttonClass} ${iconColor}`}
        title="Jump to last step (⏭)"
        aria-label="Jump to last step"
      >
        <LastIcon size={buttonSize} />
      </button>
    </div>
  );
};

export default TransportControls;
