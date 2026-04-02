'use client';

/**
 * Run list component
 * Displays run entries for a selected agent
 */

import React, { useEffect, useRef, useState } from 'react';
import { useScroll } from '../contexts/ScrollContext';
import { deserialize } from '../lib/serialization';
import { useAgentStore } from '../stores/agent';
import { useExecutionStore } from '../stores/execution';
import type { Run as AgentRun } from '../types/agent';
import MemoryIndicator from './MemoryIndicator';

interface RunListProps {
  agentId: string;
}

const STATUS_ICONS: Record<AgentRun['status'], string> = {
  running: '🟡',
  completed: '🟢',
  error: '🔴',
  paused: '🟠',
  cancelled: '⚪',
};

const STATUS_COLORS: Record<AgentRun['status'], string> = {
  running: '#f59e0b', // amber-500
  completed: '#10b981', // emerald-500
  error: '#ef4444', // red-500
  paused: '#f97316', // orange-500
  cancelled: '#9ca3af', // gray-400
};

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return '--';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (ms < 3600000) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) {
    return 'just now';
  }
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return `${minutes}m ago`;
  }
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours}h ago`;
  }
  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000);
    return `${days}d ago`;
  }

  const date = new Date(timestamp);
  // Use ISO date format to avoid hydration mismatches with locale-dependent toLocaleDateString
  return date.toISOString().split('T')[0];
}

export const RunList: React.FC<RunListProps> = ({ agentId }) => {
  const selectedRunId = useAgentStore((state) => state.selectedRunId);
  const selectRun = useAgentStore((state) => state.selectRun);
  const { getSortedRuns, updateRun } = useAgentStore();
  const { setTrace } = useExecutionStore();
  const runs = getSortedRuns(agentId);

  const handleRunClick = async (run: AgentRun) => {
    // Select the run in the store (updates URL via replaceState, no full navigation)
    selectRun(agentId, run.id);

    // Fetch full run with trace from API using RESTful nested URL
    try {
      const response = await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(run.id)}`,
      );
      if (response.ok) {
        const data: {
          success: boolean;
          data?: unknown;
        } = await response.json();
        if (data.success && data.data) {
          // Deserialize the response to convert serialized Maps back to Map instances
          const fullRun: AgentRun = deserialize<AgentRun>(data.data);
          // Update the run in agent store with full trace data
          updateRun(agentId, run.id, fullRun);
          // Cache the trace in execution store
          if (fullRun.trace) {
            setTrace(run.id, fullRun.trace);
          }
        }
      }
    } catch (error) {
      console.error('[RunList] Failed to fetch run details:', error);
    }
  };

  // Prefetch only fetches data without navigating
  const prefetchRun = async (run: AgentRun) => {
    try {
      const response = await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(run.id)}`,
      );
      if (response.ok) {
        const data: {
          success: boolean;
          data?: unknown;
        } = await response.json();
        if (data.success && data.data) {
          const fullRun: AgentRun = deserialize<AgentRun>(data.data);
          updateRun(agentId, run.id, fullRun);
          if (fullRun.trace) {
            setTrace(run.id, fullRun.trace);
          }
        }
      }
    } catch (error) {
      // Silently fail on prefetch error
      console.debug('[RunList] Prefetch failed:', error);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      }}
    >
      {runs.length === 0 ? (
        <div
          style={{
            padding: '16px',
            textAlign: 'center',
            color: 'var(--noetic-text-muted)',
            fontSize: '12px',
          }}
        >
          No runs yet
        </div>
      ) : (
        runs.map((run) => (
          <RunEntry
            key={run.id}
            agentId={agentId}
            run={run}
            isSelected={selectedRunId === run.id}
            onClick={() => handleRunClick(run)}
            onPrefetch={() => prefetchRun(run)}
          />
        ))
      )}
    </div>
  );
};

interface RunEntryProps {
  agentId: string;
  run: AgentRun;
  isSelected: boolean;
  onClick: () => void;
  onPrefetch: () => void;
}

const RunEntry: React.FC<RunEntryProps> = ({ agentId, run, isSelected, onClick, onPrefetch }) => {
  const isLive = run.isLive || run.status === 'running';
  const [isClient, setIsClient] = useState(false);
  const elementRef = useRef<HTMLButtonElement>(null);
  const { runIdToScroll, scrollToRun } = useScroll();

  useEffect(() => {
    setIsClient(true);
  }, []);

  // Scroll this run into view when it matches the scroll target
  useEffect(() => {
    if (runIdToScroll === run.id && elementRef.current) {
      elementRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
      // Clear the scroll target after scrolling
      scrollToRun(null);
    }
  }, [
    runIdToScroll,
    run.id,
    scrollToRun,
  ]);

  return (
    <RunLink
      ref={elementRef}
      isSelected={isSelected}
      isLive={isLive}
      onMouseEnter={onPrefetch}
      onClick={onClick}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            flex: 1,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: '12px',
            }}
          >
            {STATUS_ICONS[run.status]}
          </span>
          <span
            style={{
              fontSize: '11px',
              color: 'var(--noetic-text-secondary)',
              fontFamily: 'monospace',
              flexShrink: 0,
            }}
          >
            {isClient ? formatRelativeTime(run.startTime) : ''}
          </span>
          {isLive && (
            <span
              style={{
                fontSize: '9px',
                padding: '1px 4px',
                backgroundColor: STATUS_COLORS.running,
                color: '#000',
                borderRadius: '2px',
                fontWeight: 600,
              }}
            >
              LIVE
            </span>
          )}
        </div>
        <MemoryIndicator bytes={run.memoryBytes} size="sm" />
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginLeft: '18px',
        }}
      >
        <span
          style={{
            fontSize: '11px',
            color: 'var(--noetic-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
          title={run.inputPreview}
        >
          {run.inputPreview.slice(0, 50)}
          {run.inputPreview.length > 50 ? '...' : ''}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          marginLeft: '18px',
          fontSize: '10px',
          color: 'var(--noetic-text-muted)',
        }}
      >
        <span>⏱ {formatDuration(run.durationMs)}</span>
        <span>{run.totalSteps} steps</span>
        {run.totalCost > 0 && <span>${run.totalCost.toFixed(4)}</span>}
        <span>{run.totalTokens?.total?.toLocaleString() ?? '0'} tokens</span>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
      `}</style>
    </RunLink>
  );
};

// Wrapper component for run entry — uses div instead of Link to avoid full page navigation
interface RunLinkProps {
  isSelected: boolean;
  isLive: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
  children: React.ReactNode;
}

const RunLink = React.forwardRef<HTMLButtonElement, RunLinkProps>(
  ({ isSelected, isLive, onMouseEnter, onClick, children }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        onMouseEnter={onMouseEnter}
        onClick={onClick}
        onFocus={() => {}}
        onBlur={() => {}}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          padding: '8px',
          borderRadius: '4px',
          cursor: 'pointer',
          transition: 'background-color 0.15s, border-color 0.15s',
          border: isSelected
            ? '1px solid var(--noetic-selected-border)'
            : isLive
              ? `1px solid ${STATUS_COLORS.running}`
              : '1px solid transparent',
          animation: isLive ? 'pulse 2s infinite' : undefined,
          backgroundColor: isSelected ? 'var(--noetic-selected-bg)' : 'transparent',
          textAlign: 'left',
          width: '100%',
          font: 'inherit',
          color: 'inherit',
        }}
        onMouseOver={(e) => {
          if (!isSelected) {
            e.currentTarget.style.backgroundColor = 'var(--noetic-hover)';
          }
        }}
        onMouseOut={(e) => {
          if (!isSelected) {
            e.currentTarget.style.backgroundColor = 'transparent';
          }
        }}
      >
        {children}
      </button>
    );
  },
);

RunLink.displayName = 'RunLink';

export default RunList;
