'use client';

import type React from 'react';
import { useEffect } from 'react';
import { ScrollProvider } from '../contexts/ScrollContext';
import { useConnection } from '../hooks/useConnection';
import { useExecutionMessages } from '../hooks/useExecutionMessages';
import { useThemeStore } from '../stores/theme';
import { ConnectionBanner } from './ConnectionBanner';
import { ResizablePanels } from './ResizablePanels';

interface AppLayoutProps {
  children?: React.ReactNode;
}

export const AppLayout: React.FC<AppLayoutProps> = ({ children }) => {
  const { initTheme } = useThemeStore();

  // Establish single WebSocket connection to UI service
  useConnection({
    url: 'ws://localhost:3333',
    autoConnect: true,
  });

  // Process WebSocket messages and update stores
  useExecutionMessages();

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
