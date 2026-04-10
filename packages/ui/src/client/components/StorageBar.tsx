/**
 * Storage bar component
 * Displays run/token/cost summary derived from agent store
 */

import type React from 'react';
import { useState } from 'react';
import { useAgentStore } from '../stores/agent';

interface StorageBarProps {
  onClearAll?: () => void;
}

function formatTokens(n: number): string {
  if (n < 1e3) {
    return `${n}`;
  }
  if (n < 1e6) {
    return `${(n / 1e3).toFixed(1)}k`;
  }
  return `${(n / 1e6).toFixed(1)}M`;
}

export const StorageBar: React.FC<StorageBarProps> = ({ onClearAll }) => {
  const { agents, removeAgent } = useAgentStore();
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);

  if (agents.length === 0) {
    return null;
  }

  const totalRuns = agents.reduce((sum, a) => sum + a.runs.length, 0);
  const totalTokens = agents.reduce(
    (sum, a) => sum + a.runs.reduce((rs, r) => rs + (r.totalTokens?.total ?? 0), 0),
    0,
  );
  const totalCost = agents.reduce(
    (sum, a) => sum + a.runs.reduce((rs, r) => rs + (r.totalCost ?? 0), 0),
    0,
  );

  const handleClearAll = async () => {
    if (!isConfirmingClear) {
      setIsConfirmingClear(true);
      setTimeout(() => {
        setIsConfirmingClear(false);
      }, 3e3);
      return;
    }

    setIsConfirmingClear(false);

    // Delete each agent (and its runs) from the server, then clear client state
    for (const agent of agents) {
      try {
        await fetch(`/api/agents/${encodeURIComponent(agent.id)}`, {
          method: 'DELETE',
        });
      } catch {
        // Continue deleting remaining agents even if one fails
      }
      removeAgent(agent.id);
    }
    onClearAll?.();
  };

  return (
    <div
      style={{
        padding: '12px',
        borderTop: '1px solid var(--noetic-border)',
        backgroundColor: 'var(--noetic-sidebar-bg)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '13px',
          color: 'var(--noetic-text-secondary)',
        }}
      >
        <span>
          {totalRuns} run{totalRuns !== 1 ? 's' : ''}
          {totalTokens > 0 && ` · ${formatTokens(totalTokens)} tokens`}
          {totalCost > 0 && ` · $${totalCost.toFixed(4)}`}
        </span>
        <button
          type="button"
          onClick={handleClearAll}
          disabled={totalRuns === 0}
          title={isConfirmingClear ? 'Click again to confirm' : 'Clear all runs'}
          style={{
            padding: '4px',
            borderRadius: '4px',
            border: 'none',
            backgroundColor: 'transparent',
            color: isConfirmingClear ? '#ef4444' : 'var(--noetic-text-muted)',
            cursor: totalRuns === 0 ? 'not-allowed' : 'pointer',
            opacity: totalRuns === 0 ? 0.5 : 1,
            transition: 'color 0.15s',
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            role="img"
            aria-label="Clear all runs"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default StorageBar;
