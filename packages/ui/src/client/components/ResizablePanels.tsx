'use client';

import { useParams } from 'next/navigation';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deserialize } from '../lib/serialization';
import { useAgentStore } from '../stores/agent';
import { useExecutionStore } from '../stores/execution';
import { usePlaybackStore } from '../stores/playbackStore';
import { useTimelineStore } from '../stores/timelineStore';
import type { Run } from '../types/agent';
import { AgentBrowser } from './AgentBrowser';
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
interface CenterCanvasProps {
  selectedNodeId: string | null;
  onNodeSelect: (nodeId: string | null) => void;
}

function extractParamString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

const CenterCanvas: React.FC<CenterCanvasProps> = ({ selectedNodeId, onNodeSelect }) => {
  const params = useParams();
  const runId = extractParamString(params?.runId);
  const { agents } = useAgentStore();

  // Timeline / playback state for time-travel rendering
  const currentStepIndex = usePlaybackStore((s) => s.currentStepIndex);
  const playbackState = usePlaybackStore((s) => s.state);
  const markers = useTimelineStore((s) => s.markers);

  // Compute the set of node IDs that have been executed up to the current timeline position.
  // When playback is idle or live, all nodes are shown with their real status.
  const executedNodeIds = useMemo(() => {
    if (playbackState === 'idle' || playbackState === 'live' || markers.length === 0) {
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

  // Find the selected run and its trace across all agents
  const currentRun = runId ? agents.flatMap((a) => a.runs).find((r) => r.id === runId) : null;
  const currentTrace = currentRun?.trace ?? null;

  return (
    <div className="flex-1 h-full bg-[var(--noetic-canvas-bg)] relative overflow-hidden">
      {currentTrace ? (
        <NodeGraph
          trace={currentTrace}
          selectedNodeId={selectedNodeId}
          onNodeSelect={onNodeSelect}
          fitToView={true}
          executedNodeIds={executedNodeIds}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="mb-4 flex justify-center">
              <NoeticLogo size={80} />
            </div>
            <p className="text-lg text-[var(--noetic-text-secondary)]">
              {runId ? 'Loading execution trace...' : 'Select an agent to view execution'}
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

interface RightPanelProps {
  selectedNodeId: string | null;
  nodes: Map<string, import('../types').ExecutionNode>;
}

const RightPanel: React.FC<RightPanelProps> = ({ selectedNodeId, nodes }) => {
  const selectedNode = selectedNodeId ? (nodes.get(selectedNodeId) ?? null) : null;

  return (
    <div className="h-full border-l border-[var(--noetic-border)] bg-[var(--noetic-sidebar-bg)] flex flex-col">
      <NodeInspector selectedNode={selectedNode} />
    </div>
  );
};

interface ResizablePanelsProps {
  children?: React.ReactNode;
}

export const ResizablePanels: React.FC<ResizablePanelsProps> = (_props) => {
  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_WIDTH);
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_WIDTH);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [_isLoadingRun, setIsLoadingRun] = useState(false);

  // Get current run and nodes
  const params = useParams();
  const agentSlug = extractParamString(params?.agentSlug);
  const runId = extractParamString(params?.runId);
  const { agents, updateRun } = useAgentStore();
  const { setTrace } = useExecutionStore();
  const currentRun = runId ? agents.flatMap((a) => a.runs).find((r) => r.id === runId) : null;
  const nodes = currentRun?.trace?.nodes ?? new Map();

  // Fetch run data when URL has runId but run isn't loaded yet
  useEffect(() => {
    if (!agentSlug || !runId || currentRun?.trace) {
      return; // No need to fetch
    }

    // Check if we already have the run but without trace data
    const _runExists = agents.flatMap((a) => a.runs).find((r) => r.id === runId);

    const fetchRun = async () => {
      setIsLoadingRun(true);
      try {
        console.log(`[ResizablePanels] Fetching run ${runId} from API...`);
        const response = await fetch(
          `/api/agents/${encodeURIComponent(agentSlug)}/runs/${encodeURIComponent(runId)}`,
        );
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.data) {
            const fullRun = deserialize<Run>(data.data);
            updateRun(agentSlug, runId, fullRun);
            if (fullRun.trace) {
              setTrace(runId, fullRun.trace);
            }
            console.log(`[ResizablePanels] Loaded run ${runId}`);
          }
        }
      } catch (error) {
        console.error(`[ResizablePanels] Failed to fetch run ${runId}:`, error);
      } finally {
        setIsLoadingRun(false);
      }
    };

    fetchRun();
  }, [
    agentSlug,
    runId,
    currentRun?.trace,
    agents,
    updateRun,
    setTrace,
  ]);

  return (
    <>
      <div className="flex-1 flex overflow-hidden">
        <ResizableSidebar width={leftWidth} onWidthChange={setLeftWidth} side="left">
          <AgentBrowser />
        </ResizableSidebar>

        <CenterCanvas selectedNodeId={selectedNodeId} onNodeSelect={setSelectedNodeId} />

        <ResizableSidebar width={rightWidth} onWidthChange={setRightWidth} side="right">
          <RightPanel selectedNodeId={selectedNodeId} nodes={nodes} />
        </ResizableSidebar>
      </div>
      <PlaybackBar />
    </>
  );
};
