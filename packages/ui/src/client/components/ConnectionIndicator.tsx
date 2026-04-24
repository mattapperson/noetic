/**
 * ConnectionIndicator component
 * Shows WebSocket connection status with colored dot
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { useConnectionStatus, useReconnectAttempt } from '../hooks/useConnection';

interface ConnectionIndicatorProps {
  /** Additional CSS class names */
  className?: string;
  /** Show text label next to indicator (default: true) */
  showLabel?: boolean;
  /** Size of the indicator dot in pixels (default: 10) */
  dotSize?: number;
}

export const ConnectionIndicator: React.FC<ConnectionIndicatorProps> = ({
  className = '',
  showLabel = true,
  dotSize = 10,
}) => {
  const status = useConnectionStatus();
  const reconnectAttempt = useReconnectAttempt();
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  // Don't render dynamic content during SSR to avoid hydration mismatch
  if (!isClient) {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <span className="relative flex h-2.5 w-2.5">
          <span
            className="relative inline-flex rounded-full bg-slate-500"
            style={{
              width: dotSize,
              height: dotSize,
            }}
          />
        </span>
        {showLabel && <span className="text-xs font-medium text-slate-400">Loading...</span>}
      </div>
    );
  }

  const getStatusColor = () => {
    switch (status) {
      case 'connected':
        return 'bg-emerald-500';
      case 'connecting':
        return 'bg-amber-500';
      case 'disconnected':
        return 'bg-red-500';
      default:
        return 'bg-slate-500';
    }
  };

  const getStatusText = () => {
    switch (status) {
      case 'connected':
        return 'Connected';
      case 'connecting':
        return reconnectAttempt > 0
          ? `Reconnecting... (attempt ${reconnectAttempt})`
          : 'Connecting...';
      case 'disconnected':
        return 'Disconnected';
      default:
        return 'Unknown';
    }
  };

  const getStatusTitle = () => {
    switch (status) {
      case 'connected':
        return 'WebSocket connection is active';
      case 'connecting':
        return 'Attempting to establish WebSocket connection';
      case 'disconnected':
        return 'WebSocket connection lost - click to reconnect';
      default:
        return '';
    }
  };

  const isDisconnected = status === 'disconnected';

  return (
    <div className={`flex items-center gap-2 ${className}`} title={getStatusTitle()}>
      {/* Status dot with pulse animation when connecting */}
      <span className="relative flex h-2.5 w-2.5">
        {status === 'connecting' && (
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-full ${getStatusColor()} opacity-75`}
          />
        )}
        <span
          className={`relative inline-flex rounded-full ${getStatusColor()}`}
          style={{
            width: dotSize,
            height: dotSize,
          }}
        />
      </span>

      {/* Status text */}
      {showLabel && (
        <span
          className={`text-xs font-medium ${
            isDisconnected ? 'text-red-400 cursor-pointer hover:underline' : 'text-slate-400'
          }`}
        >
          {getStatusText()}
        </span>
      )}
    </div>
  );
};

export default ConnectionIndicator;
