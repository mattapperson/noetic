/**
 * Agent list component
 * Displays agents with expand/collapse functionality
 */

import { useParams, useRouter } from 'next/navigation';
import React from 'react';
import { useHasHydrated } from '../hooks/useHasHydrated';
import { useAgentStore } from '../stores/agent';
import type { Agent } from '../types/agent';
import { useConfirmDialog } from './ConfirmDialog';
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
  return date.toISOString().split('T')[0];
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
  const router = useRouter();
  const params = useParams();
  const selectedAgentId = params?.agentSlug as string | undefined;
  const { expandedAgentIds, toggleAgentExpanded, removeAgent } = useAgentStore();
  const hasHydrated = useHasHydrated();

  const handleDeleteAgent = React.useCallback(
    (agentId: string) => {
      removeAgent(agentId);
    },
    [
      removeAgent,
    ],
  );

  const handleSelectAgent = React.useCallback(
    (agentId: string) => {
      router.push(`/${agentId}`);
    },
    [
      router,
    ],
  );

  // During SSR and initial hydration, don't use persisted state to avoid mismatches
  const safeExpandedIds = hasHydrated ? expandedAgentIds : new Set<string>();
  const safeSelectedId = hasHydrated ? selectedAgentId : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      }}
    >
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
            isExpanded={safeExpandedIds.has(agent.id)}
            isSelected={safeSelectedId === agent.id}
            onToggleExpand={() => toggleAgentExpanded(agent.id)}
            onSelect={() => handleSelectAgent(agent.id)}
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
  const [isClient, setIsClient] = React.useState(false);
  const { showConfirm } = useConfirmDialog();

  React.useEffect(() => {
    setIsClient(true);
  }, []);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDeleting) {
      return;
    }

    const confirmed = await showConfirm({
      title: 'Delete Agent',
      description: `Delete agent "${agent.name}" and all its runs? This cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      onConfirm: () => {},
      onCancel: () => {},
    });

    if (!confirmed) {
      return;
    }

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
        backgroundColor: isSelected ? 'var(--noetic-selected-bg)' : 'transparent',
        border: isSelected ? '1px solid var(--noetic-selected-border)' : '1px solid transparent',
        transition: 'background-color 0.15s, border-color 0.15s',
      }}
    >
      {/* Agent row - clicking anywhere expands/collapses, does NOT navigate */}
      <div
        onClick={onToggleExpand}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px',
          width: '100%',
          backgroundColor: 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleExpand();
          }
        }}
      >
        <div
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onToggleExpand();
            }
          }}
          role="button"
          tabIndex={0}
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
        </div>

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
            {isClient ? formatRelativeTime(agent.lastRunAt) : ''}
          </span>
        </div>

        <div
          onClick={handleDelete}
          role="button"
          tabIndex={isDeleting ? -1 : 0}
          aria-disabled={isDeleting}
          onKeyDown={(e) => {
            if (!isDeleting && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              e.stopPropagation();
              void handleDelete(e as unknown as React.MouseEvent);
            }
          }}
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
        </div>
      </div>

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
