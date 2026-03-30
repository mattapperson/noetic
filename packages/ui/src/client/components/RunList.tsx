/**
 * Run list component
 * Displays run entries for a selected agent
 */

import type React from 'react';
import { useAgentStore } from '../stores/agent';
import { useExecutionStore } from '../stores/execution';
import type { Run, RunSortOption } from '../types/agent';
import MemoryIndicator from './MemoryIndicator';

interface RunListProps {
  agentId: string;
}

const STATUS_ICONS: Record<Run['status'], string> = {
  pending: '⏳',
  running: '🟡',
  completed: '🟢',
  error: '🔴',
  paused: '🟠',
  cancelled: '⚪',
};

const STATUS_COLORS: Record<Run['status'], string> = {
  pending: '#6b7280', // gray-500
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
  return date.toLocaleDateString();
}

export const RunList: React.FC<RunListProps> = ({ agentId }) => {
  const { getSortedRuns, runSort, setRunSort } = useAgentStore();
  const { selectRun } = useExecutionStore();
  const runs = getSortedRuns(agentId);

  const sortOptions: {
    value: RunSortOption;
    label: string;
  }[] = [
    {
      value: 'recent',
      label: 'Recent first',
    },
    {
      value: 'oldest',
      label: 'Oldest first',
    },
    {
      value: 'duration',
      label: 'Duration',
    },
    {
      value: 'cost',
      label: 'Cost',
    },
    {
      value: 'memory',
      label: 'Memory',
    },
  ];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 8px',
          borderBottom: '1px solid var(--noetic-border)',
        }}
      >
        <span
          style={{
            fontSize: '10px',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--noetic-text-muted)',
          }}
        >
          {runs.length} run{runs.length !== 1 ? 's' : ''}
        </span>
        <select
          value={runSort}
          onChange={(e) => {
            const value = e.target.value;
            if (
              value === 'recent' ||
              value === 'oldest' ||
              value === 'duration' ||
              value === 'cost' ||
              value === 'memory'
            ) {
              setRunSort(value);
            }
          }}
          style={{
            fontSize: '10px',
            padding: '2px 6px',
            borderRadius: '4px',
            border: '1px solid var(--noetic-border)',
            backgroundColor: 'var(--noetic-input-bg)',
            color: 'var(--noetic-text)',
            cursor: 'pointer',
          }}
        >
          {sortOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

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
        runs.map((run) => <RunEntry key={run.id} run={run} onClick={() => selectRun(run.id)} />)
      )}
    </div>
  );
};

interface RunEntryProps {
  run: Run;
  onClick: () => void;
}

const RunEntry: React.FC<RunEntryProps> = ({ run, onClick }) => {
  const isLive = run.isLive || run.status === 'running';

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '8px',
        borderRadius: '4px',
        cursor: 'pointer',
        transition: 'background-color 0.15s',
        border: isLive ? '1px solid ' + STATUS_COLORS.running : '1px solid transparent',
        animation: isLive ? 'pulse 2s infinite' : undefined,
        backgroundColor: 'transparent',
        textAlign: 'left',
        width: '100%',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = 'var(--noetic-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent';
      }}
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
            {formatRelativeTime(run.startTime)}
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
        {run.totalCost > 0 && <span>${run.totalCost.toFixed(4)}</span>}
        <span>{run.totalTokens.total.toLocaleString()} tokens</span>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
      `}</style>
    </button>
  );
};

export default RunList;
