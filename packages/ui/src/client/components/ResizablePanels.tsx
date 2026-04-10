'use client';

import { useRouter } from 'next/navigation';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useColumnWidths } from '../hooks/useColumnWidths';
import { deserialize, ensureMap } from '../lib/serialization';
import { useAgentStore } from '../stores/agent';
import { useExecutionStore } from '../stores/execution';
import { usePlaybackStore } from '../stores/playbackStore';
import { markerIdForNode, useTimelineStore } from '../stores/timelineStore';
import type { ExecutionTrace } from '../types';
import type { Run } from '../types/agent';
import { AgentBrowser } from './AgentBrowser';

/** Shared selector: returns the trace for the currently selected run, or null.
 *  Referentially stable as long as the trace object on the run doesn't change. */
const selectCurrentTrace = (s: {
  selectedRunId: string | null;
  agents: Array<{
    runs: Array<{
      id: string;
      trace?: ExecutionTrace;
    }>;
  }>;
}): ExecutionTrace | null => {
  if (!s.selectedRunId) {
    return null;
  }
  for (const agent of s.agents) {
    for (const run of agent.runs) {
      if (run.id === s.selectedRunId) {
        return run.trace ?? null;
      }
    }
  }
  return null;
};

import { NodeGraph } from './NodeGraph';
import { NodeInspector } from './NodeInspector';
import { NoeticLogo } from './NoeticLogo';
import { PlaybackBar } from './PlaybackBar';

// Minimum and maximum widths for resizable panels
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 500;
const DEFAULT_LEFT_WIDTH = 280;
const DEFAULT_RIGHT_WIDTH = 320;

interface ResizableSidebarProps {
  children: React.ReactNode;
  width: number;
  onWidthChange: (width: number) => void;
  side: 'left' | 'right';
  className?: string;
  isHydrated?: boolean;
}

const ResizableSidebar: React.FC<ResizableSidebarProps> = ({
  children,
  width,
  onWidthChange,
  side,
  className = '',
  isHydrated = true,
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
        // Smooth transition when loading persisted width after hydration
        // Disable during drag for responsive resizing
        transition: isDragging || !isHydrated ? undefined : 'width 300ms ease-out',
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
interface CenterCanvasProps {
  selectedNodeId: string | null;
  selectionKey: number;
  onNodeSelect: (nodeId: string | null) => void;
}

const CenterCanvas: React.FC<CenterCanvasProps> = ({
  selectedNodeId,
  selectionKey,
  onNodeSelect,
}) => {
  const currentTrace = useAgentStore(selectCurrentTrace);
  const runId = useAgentStore((s) => s.selectedRunId);

  // Timeline / playback state for time-travel rendering
  const currentStepIndex = usePlaybackStore((s) => s.currentStepIndex);
  const playbackState = usePlaybackStore((s) => s.state);
  const markers = useTimelineStore((s) => s.markers);

  // Compute the set of node IDs that have been executed up to the current timeline position.
  // In live mode, all nodes are shown with their real status.
  // In all other states (idle, playing, paused), only nodes up to currentStepIndex are visible.
  const executedNodeIds = useMemo(() => {
    if (playbackState === 'live' || markers.length === 0) {
      return undefined;
    }
    const ids = new Set<string>();
    for (let i = 0; i <= currentStepIndex && i < markers.length; i++) {
      ids.add(markers[i].nodeId);
    }
    return ids;
  }, [
    currentStepIndex,
    playbackState,
    markers,
  ]);

  return (
    <div className="flex-1 h-full bg-[var(--noetic-canvas-bg)] relative overflow-hidden">
      {currentTrace ? (
        <NodeGraph
          trace={currentTrace}
          selectedNodeId={selectedNodeId}
          selectionKey={selectionKey}
          onNodeSelect={onNodeSelect}
          fitToView={true}
          executedNodeIds={executedNodeIds}
        />
      ) : runId ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="mb-4 flex justify-center">
              <NoeticLogo size={80} />
            </div>
            <p className="text-lg text-[var(--noetic-text-secondary)]">
              Loading execution trace...
            </p>
          </div>
        </div>
      ) : (
        <WelcomeScreen />
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

interface RightPanelProps {
  selectedNodeId: string | null;
  nodes: unknown; // Can be Map or serialized object
}

const RightPanel: React.FC<RightPanelProps> = ({ selectedNodeId, nodes }) => {
  // Ensure nodes is a Map using ensureMap
  const nodeMap = ensureMap<string, import('../types').ExecutionNode>(nodes);
  const selectedNode = selectedNodeId ? (nodeMap.get(selectedNodeId) ?? null) : null;

  return (
    <div className="h-full border-l border-[var(--noetic-border)] bg-[var(--noetic-sidebar-bg)] flex flex-col">
      <NodeInspector selectedNode={selectedNode} />
    </div>
  );
};

const WelcomeScreen: React.FC = () => {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-8">
      <div
        style={{
          maxWidth: '520px',
          width: '100%',
        }}
      >
        <div className="flex justify-center mb-6">
          <NoeticLogo size={64} />
        </div>
        <h1
          style={{
            fontSize: '24px',
            fontWeight: 600,
            color: 'var(--noetic-text)',
            textAlign: 'center',
            margin: '0 0 8px 0',
          }}
        >
          Noetic Debugger
        </h1>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--noetic-text-muted)',
            textAlign: 'center',
            margin: '0 0 32px 0',
          }}
        >
          Visual debugger for Noetic agent workflows
        </p>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
        >
          <WelcomeCard
            title="Select a run"
            description="Expand an agent in the left sidebar and click a run to load its execution trace."
            icon="1"
          />
          <WelcomeCard
            title="Explore the graph"
            description="Pan and zoom the node graph to follow execution flow. Click a node to inspect its data in the right panel."
            icon="2"
          />
          <WelcomeCard
            title="Time-travel debugging"
            description="Use the playback bar at the bottom to scrub through execution history and see the state at any point in time."
            icon="3"
          />
        </div>

        <div
          style={{
            marginTop: '24px',
            padding: '12px 16px',
            borderRadius: '6px',
            backgroundColor: 'var(--noetic-node-bg)',
            border: '1px solid var(--noetic-border)',
            fontSize: '12px',
            color: 'var(--noetic-text-muted)',
            textAlign: 'center',
          }}
        >
          Enable debug mode with{' '}
          <code
            style={{
              padding: '2px 6px',
              borderRadius: '3px',
              backgroundColor: 'var(--noetic-code-bg, rgba(0,0,0,0.2))',
              color: 'var(--noetic-text-secondary)',
              fontFamily: 'monospace',
              fontSize: '11px',
            }}
          >
            NOETIC_UI_ENABLED=true
          </code>{' '}
          to record agent runs automatically.
        </div>
      </div>
    </div>
  );
};

interface WelcomeCardProps {
  title: string;
  description: string;
  icon: string;
}

const WelcomeCard: React.FC<WelcomeCardProps> = ({ title, description, icon }) => {
  return (
    <div
      style={{
        display: 'flex',
        gap: '14px',
        alignItems: 'flex-start',
        padding: '14px 16px',
        borderRadius: '6px',
        border: '1px solid var(--noetic-border)',
        backgroundColor: 'var(--noetic-node-bg)',
      }}
    >
      <span
        style={{
          width: '24px',
          height: '24px',
          borderRadius: '50%',
          backgroundColor: 'var(--noetic-accent, #3b82f6)',
          color: '#fff',
          fontSize: '12px',
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div>
        <div
          style={{
            fontSize: '13px',
            fontWeight: 600,
            color: 'var(--noetic-text)',
            marginBottom: '4px',
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: '12px',
            color: 'var(--noetic-text-muted)',
            lineHeight: '1.5',
          }}
        >
          {description}
        </div>
      </div>
    </div>
  );
};

interface ResizablePanelsProps {
  children?: React.ReactNode;
}

export const ResizablePanels: React.FC<ResizablePanelsProps> = (_props) => {
  const router = useRouter();
  // Use persisted column widths from localStorage
  const { leftWidth, rightWidth, setLeftWidth, setRightWidth, hasHydrated } = useColumnWidths({
    defaultLeftWidth: DEFAULT_LEFT_WIDTH,
    defaultRightWidth: DEFAULT_RIGHT_WIDTH,
    minWidth: MIN_SIDEBAR_WIDTH,
    maxWidth: MAX_SIDEBAR_WIDTH,
  });

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectionKey, setSelectionKey] = useState(0);
  const [_isLoadingRun, setIsLoadingRun] = useState(false);

  // Handle timeline marker click → select + focus node in graph + inspector
  const handleTimelineChange = useCallback((_stepIndex: number, nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectionKey((k) => k + 1);
    // Also sync the timeline marker so playhead and step index stay consistent
    const { markers, selectMarker, setPlayheadPosition } = useTimelineStore.getState();
    const markerId = markerIdForNode(nodeId);
    const marker = markers.find((m) => m.id === markerId);
    if (marker) {
      selectMarker(markerId);
      setPlayheadPosition(marker.position);
    }
  }, []);

  // Handle node click in graph → update timeline marker
  const handleNodeSelect = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    if (!nodeId) {
      return;
    }
    const { markers, selectMarker, setPlayheadPosition } = useTimelineStore.getState();
    const markerId = markerIdForNode(nodeId);
    const marker = markers.find((m) => m.id === markerId);
    if (marker) {
      selectMarker(markerId);
      setPlayheadPosition(marker.position);
      const index = markers.indexOf(marker);
      if (index !== -1) {
        usePlaybackStore.getState().jumpToStep(index);
      }
    }
  }, []);

  // Sync selected node when transport controls change the step index
  const currentStepIndex = usePlaybackStore((s) => s.currentStepIndex);
  const markers = useTimelineStore((s) => s.markers);
  useEffect(() => {
    const marker = markers[currentStepIndex];
    if (marker) {
      setSelectedNodeId(marker.nodeId);
    }
  }, [
    currentStepIndex,
    markers,
  ]);

  // Use selectors to derive only the data we need — avoids re-rendering when
  // unrelated agent store fields change (e.g. hover prefetch on a different run).
  const agentSlug = useAgentStore((s) => s.selectedAgentId);
  const runId = useAgentStore((s) => s.selectedRunId);
  const currentTrace = useAgentStore(selectCurrentTrace);
  // Track whether the selected agent exists in the store (needed to re-run
  // the fetch effect after AgentBrowser populates the store on hard refresh).
  const agentLoaded = useAgentStore((s) =>
    s.selectedAgentId ? s.agents.some((a) => a.id === s.selectedAgentId) : false,
  );
  // Ensure nodes is a Map using ensureMap
  const nodes = useMemo(
    () => ensureMap<string, import('../types').ExecutionNode>(currentTrace?.nodes ?? new Map()),
    [
      currentTrace,
    ],
  );

  // Fetch run data when URL has runId but run isn't loaded yet.
  // Depends on `agentLoaded` so it re-runs after AgentBrowser populates the
  // store on hard refresh (updateRun no-ops if the agent doesn't exist yet).
  useEffect(() => {
    if (!agentSlug || !runId || currentTrace || !agentLoaded) {
      return;
    }

    const fetchRun = async () => {
      setIsLoadingRun(true);
      try {
        const response = await fetch(
          `/api/agents/${encodeURIComponent(agentSlug)}/runs/${encodeURIComponent(runId)}`,
        );
        if (!response.ok) {
          // Run doesn't exist — redirect to index
          router.replace('/');
          return;
        }
        const data = await response.json();
        if (!data.success || !data.data) {
          router.replace('/');
          return;
        }
        const fullRun = deserialize<Run>(data.data);
        useAgentStore.getState().updateRun(agentSlug, runId, fullRun);
        if (fullRun.trace) {
          useExecutionStore.getState().setTrace(runId, fullRun.trace);
        }
      } catch (error) {
        console.error(`[ResizablePanels] Failed to fetch run ${runId}:`, error);
        window.location.replace('/');
      } finally {
        setIsLoadingRun(false);
      }
    };

    fetchRun();
  }, [
    agentSlug,
    runId,
    currentTrace,
    agentLoaded,
    router.replace,
  ]);

  return (
    <>
      <div className="flex-1 flex overflow-hidden">
        <ResizableSidebar
          width={leftWidth}
          onWidthChange={setLeftWidth}
          side="left"
          isHydrated={hasHydrated}
        >
          <AgentBrowser />
        </ResizableSidebar>

        <CenterCanvas
          selectedNodeId={selectedNodeId}
          selectionKey={selectionKey}
          onNodeSelect={handleNodeSelect}
        />

        {currentTrace && (
          <ResizableSidebar
            width={rightWidth}
            onWidthChange={setRightWidth}
            side="right"
            isHydrated={hasHydrated}
          >
            <RightPanel selectedNodeId={selectedNodeId} nodes={nodes} />
          </ResizableSidebar>
        )}
      </div>
      <div
        style={{
          overflow: 'hidden',
          maxHeight: currentTrace ? '200px' : '0px',
          transition: 'max-height 0.3s ease-in-out',
        }}
      >
        <PlaybackBar onTimelineChange={handleTimelineChange} />
      </div>
    </>
  );
};
