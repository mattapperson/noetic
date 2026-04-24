'use client';

import type React from 'react';
import { useEffect, useState } from 'react';
import { useConnectionStatus } from '../hooks/useConnection';
import { ConnectionIndicator } from './ConnectionIndicator';

export const ConnectionBanner: React.FC = () => {
  const status = useConnectionStatus();
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  // Don't render during SSR to avoid hydration mismatch
  if (!isClient) {
    return null;
  }

  if (status === 'connected') {
    return null;
  }

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <ConnectionIndicator showLabel={false} dotSize={8} />
        <span className="text-sm text-amber-400">
          {status === 'connecting' ? 'Connecting to server...' : 'Server disconnected'}
        </span>
      </div>
      <span className="text-xs text-amber-400/70">
        Run: <code className="bg-amber-500/20 px-1.5 py-0.5 rounded">npx @noetic/ui serve</code>
      </span>
    </div>
  );
};
