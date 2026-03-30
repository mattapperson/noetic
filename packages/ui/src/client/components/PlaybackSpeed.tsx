/**
 * PlaybackSpeed component
 * Speed toggle buttons: 1x, 2x, 5x, 10x
 */

import type React from 'react';
import type { PlaybackSpeed } from '../stores';
import { usePlaybackSpeed, usePlaybackStore } from '../stores';

interface PlaybackSpeedProps {
  /** Additional CSS class names */
  className?: string;
  /** Whether to show the live button (default: true) */
  showLiveButton?: boolean;
}

const SPEEDS: PlaybackSpeed[] = [
  1,
  2,
  5,
  10,
];

export const PlaybackSpeedControl: React.FC<PlaybackSpeedProps> = ({
  className = '',
  showLiveButton = true,
}) => {
  const currentSpeed = usePlaybackSpeed();
  const { setSpeed, state, enableLiveMode, disableLiveMode } = usePlaybackStore();
  const isLive = state === 'live';

  const handleSpeedClick = (speed: PlaybackSpeed) => {
    if (isLive) {
      disableLiveMode();
    }
    setSpeed(speed);
  };

  const handleLiveClick = () => {
    if (isLive) {
      disableLiveMode();
    } else {
      enableLiveMode();
    }
  };

  const baseButtonClass = `
    px-2 py-1
    text-xs font-medium
    rounded-md
    transition-all duration-150
    focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
    disabled:opacity-40 disabled:cursor-not-allowed
  `;

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {/* Speed buttons */}
      {SPEEDS.map((speed) => {
        const isActive = currentSpeed === speed && !isLive;
        const buttonClass = isActive
          ? `${baseButtonClass} bg-blue-600 text-white hover:bg-blue-700`
          : `${baseButtonClass} bg-slate-700 text-slate-300 hover:bg-slate-600`;

        return (
          <button
            key={speed}
            type="button"
            onClick={() => handleSpeedClick(speed)}
            className={buttonClass}
            title={`Playback speed: ${speed}x`}
            aria-label={`Set playback speed to ${speed}x`}
            aria-pressed={isActive}
          >
            {speed}x
          </button>
        );
      })}

      {/* Live button */}
      {showLiveButton && (
        <button
          type="button"
          onClick={handleLiveClick}
          className={`
            ${baseButtonClass}
            ${
              isLive
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }
          `}
          title={isLive ? 'Live mode active' : 'Switch to live mode'}
          aria-label={isLive ? 'Live mode is active' : 'Enable live mode'}
          aria-pressed={isLive}
        >
          <span className="flex items-center gap-1">
            {isLive && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
            )}
            Live
          </span>
        </button>
      )}
    </div>
  );
};

export default PlaybackSpeedControl;
