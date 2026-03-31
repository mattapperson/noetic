/**
 * Agent list component
 * Displays agents with expand/collapse functionality
 */

import React from 'react';
import { useAgentStore } from '../stores/agent';
import type { Agent, AgentSortOption } from '../types/agent';
import RunList from './RunList';

const STATUS_ICONS = {
  active: '🟢',
  inactive: '⚪',
  error: '🔴',
};

interface AgentListProps {
  agents: Agent[];
}

function formatRelativeTime(timestamp: number | null): string {
  if (timestamp === null) {
    return 'Never';
  }

  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) {
    return 'Just now';
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

function getAgentStatus(agent: Agent): keyof typeof STATUS_ICONS {
  if (agent.runs.some((r) => r.status === 'error')) {
    return 'error';
  }
  if (agent.runs.some((r) => r.status === 'running')) {
    return 'active';
  }
  return 'inactive';
}

export const AgentList: React.FC<AgentListProps> = ({ agents }) => {
  const {
    expandedAgentIds,
    selectedAgentId,
    toggleAgentExpanded,
    selectAgent,
    removeAgent,
    agentSort,
    setAgentSort,
  } = useAgentStore();

  const handleDeleteAgent = React.useCallback(
    (agentId: string) => {
      removeAgent(agentId);
    },
    [
      removeAgent,
    ],
  );

  const sortOptions: {
    value: AgentSortOption;
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
      value: 'name',
      label: 'Name',
    },
    {
      value: 'runs',
      label: 'Run count',
    },
  ];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px',
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
          {agents.length} agent{agents.length !== 1 ? 's' : ''}
        </span>
        <select
          value={agentSort}
          onChange={(e) => {
            const value = e.target.value;
            if (value === 'recent' || value === 'oldest' || value === 'name' || value === 'runs') {
              setAgentSort(value);
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

      {agents.length === 0 ? (
        <div
          style={{
            padding: '24px 16px',
            textAlign: 'center',
            color: 'var(--noetic-text-muted)',
            fontSize: '12px',
          }}
        >
          No agents discovered
          <br />
          <span
            style={{
              fontSize: '11px',
              marginTop: '4px',
              display: 'block',
            }}
          >
            Run discovery to find agents in your codebase
          </span>
        </div>
      ) : (
        agents.map((agent) => (
          <AgentEntry
            key={agent.id}
            agent={agent}
            isExpanded={expandedAgentIds.has(agent.id)}
            isSelected={selectedAgentId === agent.id}
            onToggleExpand={() => toggleAgentExpanded(agent.id)}
            onSelect={() => selectAgent(agent.id)}
            onDelete={handleDeleteAgent}
          />
        ))
      )}
    </div>
  );
};

interface AgentEntryProps {
  agent: Agent;
  isExpanded: boolean;
  isSelected: boolean;
  onToggleExpand: () => void;
  onSelect: () => void;
  onDelete?: (agentId: string) => void;
}

const AgentEntry: React.FC<AgentEntryProps> = ({
  agent,
  isExpanded,
  isSelected,
  onToggleExpand,
  onSelect,
  onDelete,
}) => {
  const status = getAgentStatus(agent);
  const icon = STATUS_ICONS[status];
  const [isDeleting, setIsDeleting] = React.useState(false);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDeleting) return;

    const confirmed = window.confirm(
      `Delete agent "${agent.name}" and all its runs? This cannot be undone.`,
    );
    if (!confirmed) return;

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agent.id)}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (data.success) {
        onDelete?.(agent.id);
      } else {
        throw new Error(data.error || 'Failed to delete agent');
      }
    } catch (error) {
      console.error('Failed to delete agent:', error);
      alert('Failed to delete agent. See console for details.');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div
      style={{
        borderRadius: '4px',
        overflow: 'hidden',
        backgroundColor: isSelected ? 'var(--noetic-selected-bg, #1e293b)' : 'transparent',
        border: isSelected ? '1px solid var(--noetic-accent)' : '1px solid transparent',
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px',
          width: '100%',
          backgroundColor: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
          style={{
            width: '16px',
            height: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--noetic-text-muted)',
            fontSize: '10px',
            padding: 0,
          }}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
        >
          {isExpanded ? '▼' : '▶'}
        </button>

        <span
          style={{
            fontSize: '12px',
          }}
        >
          {icon}
        </span>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: '12px',
              fontWeight: 500,
              color: 'var(--noetic-text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={agent.name}
          >
            {agent.name}
          </span>
          <span
            style={{
              fontSize: '10px',
              color: 'var(--noetic-text-muted)',
              fontFamily: 'monospace',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={agent.filePath}
          >
            {agent.filePath}
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: '2px',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: '10px',
              color: 'var(--noetic-text-muted)',
            }}
          >
            {agent.runCount} run{agent.runCount !== 1 ? 's' : ''}
          </span>
          <span
            style={{
              fontSize: '9px',
              color: 'var(--noetic-text-secondary)',
            }}
          >
            {formatRelativeTime(agent.lastRunAt)}
          </span>
        </div>

        <button
          type="button"
          onClick={handleDelete}
          disabled={isDeleting}
          style={{
            width: '20px',
            height: '20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'transparent',
            border: 'none',
            cursor: isDeleting ? 'not-allowed' : 'pointer',
            color: 'var(--noetic-text-muted)',
            fontSize: '12px',
            padding: 0,
            marginLeft: '4px',
            opacity: isDeleting ? 0.5 : 1,
          }}
          title="Delete agent"
          aria-label="Delete agent"
        >
          {isDeleting ? '...' : '×'}
        </button>
      </button>

      {isExpanded && (
        <div
          style={{
            marginLeft: '24px',
            padding: '0 8px 8px 8px',
            borderLeft: '1px solid var(--noetic-border)',
          }}
        >
          <RunList agentId={agent.id} />
        </div>
      )}
    </div>
  );
};

export default AgentList;
