'use client';

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentBrowser } from './components/AgentBrowser';
import { ConnectionIndicator } from './components/ConnectionIndicator';
import { NodeGraph } from './components/NodeGraph';
import { NodeInspector } from './components/NodeInspector';
import { NoeticLogo } from './components/NoeticLogo';
import { PlaybackBar } from './components/PlaybackBar';
import { useConnection, useConnectionStatus } from './hooks/useConnection';
import { useExecutionMessages } from './hooks/useExecutionMessages';
import { useExecutionStore } from './stores/execution';
import { useThemeStore } from './stores/theme';

// Minimum and maximum widths for resizable panels
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 500;
const DEFAULT_LEFT_WIDTH = 280;
const DEFAULT_RIGHT_WIDTH = 320;

// Connection status banner shown when disconnected
const ConnectionBanner: React.FC = () => {
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

// Resizable sidebar wrapper with drag handle
interface ResizableSidebarProps {
  children: React.ReactNode;
  width: number;
  onWidthChange: (width: number) => void;
  side: 'left' | 'right';
  className?: string;
}

const ResizableSidebar: React.FC<ResizableSidebarProps> = ({
  children,
  width,
  onWidthChange,
  side,
  className = '',
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      startXRef.current = e.clientX;
      startWidthRef.current = width;
    },
    [
      width,
    ],
  );

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      const delta = side === 'left' ? e.clientX - startXRef.current : startXRef.current - e.clientX;

      const newWidth = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, startWidthRef.current + delta),
      );
      onWidthChange(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [
    isDragging,
    side,
    onWidthChange,
  ]);

  return (
    <div
      className={`relative flex-shrink-0 ${className}`}
      style={{
        width,
      }}
    >
      {children}
      {/* Resize handle */}
      <button
        type="button"
        className={`absolute top-0 ${side === 'left' ? 'right-0' : 'left-0'} w-1 h-full cursor-col-resize hover:bg-[var(--noetic-accent)] transition-colors z-50 bg-transparent border-none p-0`}
        onMouseDown={handleMouseDown}
        style={{
          backgroundColor: isDragging ? 'var(--noetic-accent)' : 'transparent',
        }}
        title={`Drag to resize ${side} panel`}
        aria-label={`Resize ${side} panel`}
      />
    </div>
  );
};

// Center canvas shows node graph for selected run
const CenterCanvas: React.FC = () => {
  const { currentRun, traces, selectedNode, selectNode } = useExecutionStore();

  // Get trace for current run
  const currentTrace = currentRun ? (traces.get(currentRun.id) ?? null) : null;

  return (
    <div className="flex-1 h-full bg-[var(--noetic-canvas-bg)] relative overflow-hidden">
      {currentTrace ? (
        <NodeGraph
          trace={currentTrace}
          selectedNodeId={selectedNode?.stepId ?? null}
          onNodeSelect={(nodeId) => selectNode(nodeId)}
          onNodeDeselect={() => selectNode(null)}
          fitToView={true}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="mb-4 flex justify-center">
              <NoeticLogo size={80} />
            </div>
            <p className="text-lg text-[var(--noetic-text-secondary)]">
              {currentRun ? 'Loading execution trace...' : 'Select an agent to view execution'}
            </p>
          </div>
        </div>
      )}

      {/* Grid pattern overlay */}
      <div
        className="absolute inset-0 pointer-events-none opacity-30"
        style={{
          backgroundImage: `
            radial-gradient(circle, var(--noetic-grid-color) 1px, transparent 1px)
          `,
          backgroundSize: '20px 20px',
        }}
      />
    </div>
  );
};

const RightPanel: React.FC = () => {
  return (
    <div className="h-full border-l border-[var(--noetic-border)] bg-[var(--noetic-sidebar-bg)] flex flex-col">
      <NodeInspector />
    </div>
  );
};

export const App: React.FC = () => {
  const { initTheme } = useThemeStore();
  const { nodes } = useExecutionStore();

  // Resizable panel widths
  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_WIDTH);
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_WIDTH);

  // Establish single WebSocket connection to UI service
  useConnection({
    url: 'ws://localhost:3333',
    autoConnect: true,
  });

  // Process WebSocket messages and update stores
  useExecutionMessages();

  useEffect(() => {
    initTheme();
  }, [
    initTheme,
  ]);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[var(--noetic-bg)]">
      <ConnectionBanner />
      <div className="flex-1 flex overflow-hidden">
        <ResizableSidebar width={leftWidth} onWidthChange={setLeftWidth} side="left">
          <AgentBrowser />
        </ResizableSidebar>

        <CenterCanvas />

        <ResizableSidebar width={rightWidth} onWidthChange={setRightWidth} side="right">
          <RightPanel />
        </ResizableSidebar>
      </div>
      <PlaybackBar nodes={nodes} />
    </div>
  );
};

export default App;
