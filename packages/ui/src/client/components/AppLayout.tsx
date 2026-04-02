'use client';

import type React from 'react';
import { useEffect } from 'react';
import { ScrollProvider } from '../contexts/ScrollContext';
import { useConnection } from '../hooks/useConnection';
import { useExecutionMessages } from '../hooks/useExecutionMessages';
import { useHistoricalRuns } from '../hooks/useHistoricalRuns';
import { useThemeStore } from '../stores/theme';
import { ConnectionBanner } from './ConnectionBanner';
import { ResizablePanels } from './ResizablePanels';

interface AppLayoutProps {
  children?: React.ReactNode;
}

function getWebSocketUrl(): string {
  // Allow override via meta tag injected by server
  if (typeof document !== 'undefined') {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="noetic-ws-url"]');
    if (meta?.content) {
      return meta.content;
    }
  }
  // Fall back to same host with default port
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.hostname}:3333`;
  }
  return 'ws://localhost:3333';
}

export const AppLayout: React.FC<AppLayoutProps> = ({ children }) => {
  const { initTheme } = useThemeStore();

  // Establish single WebSocket connection to UI service
  useConnection({
    url: getWebSocketUrl(),
    autoConnect: true,
  });

  // Process WebSocket messages and update stores
  useExecutionMessages();

  // Load historical runs from REST API on startup
  useHistoricalRuns();

  // Initialize theme
  useEffect(() => {
    initTheme();
  }, [
    initTheme,
  ]);

  return (
    <ScrollProvider>
      <div className="h-full w-full flex flex-col">
        <ConnectionBanner />
        <ResizablePanels>{children}</ResizablePanels>
      </div>
    </ScrollProvider>
  );
};
