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
  const { agents, removeAllRuns, removeAgent } = useAgentStore();
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
          marginBottom: '8px',
          fontSize: '11px',
          color: 'var(--noetic-text-secondary)',
        }}
      >
        <span>
          {totalRuns} run{totalRuns !== 1 ? 's' : ''}
          {totalTokens > 0 && ` · ${formatTokens(totalTokens)} tokens`}
          {totalCost > 0 && ` · $${totalCost.toFixed(4)}`}
        </span>
      </div>

      <button
        type="button"
        onClick={handleClearAll}
        disabled={totalRuns === 0}
        style={{
          width: '100%',
          padding: '6px 10px',
          fontSize: '11px',
          borderRadius: '4px',
          border: isConfirmingClear ? '1px solid #ef4444' : '1px solid var(--noetic-border)',
          backgroundColor: isConfirmingClear ? '#ef444420' : 'var(--noetic-button-bg)',
          color: isConfirmingClear ? '#ef4444' : 'var(--noetic-text)',
          cursor: totalRuns === 0 ? 'not-allowed' : 'pointer',
          opacity: totalRuns === 0 ? 0.5 : 1,
          transition: 'all 0.15s',
        }}
      >
        {isConfirmingClear ? 'Click again to confirm' : 'Clear all runs'}
      </button>
    </div>
  );
};

export default StorageBar;
