/**
 * Storage bar component
 * Displays run/token/cost summary derived from agent store
 */

import type React from 'react';
import { useEffect, useState } from 'react';
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

  // Dismiss confirmation when clicking anywhere outside the trash button
  useEffect(() => {
    if (!isConfirmingClear) {
      return;
    }
    const dismiss = () => setIsConfirmingClear(false);
    window.addEventListener('click', dismiss);
    return () => window.removeEventListener('click', dismiss);
  }, [
    isConfirmingClear,
  ]);

  if (agents.length === 0) {
    return null;
  }

  const totalRuns = agents.reduce((sum, a) => sum + a.runs.length, 0);
  const totalInputTokens = agents.reduce(
    (sum, a) => sum + a.runs.reduce((rs, r) => rs + (r.totalTokens?.input ?? 0), 0),
    0,
  );
  const totalOutputTokens = agents.reduce(
    (sum, a) => sum + a.runs.reduce((rs, r) => rs + (r.totalTokens?.output ?? 0), 0),
    0,
  );
  const totalTokens = totalInputTokens + totalOutputTokens;
  const totalCost = agents.reduce(
    (sum, a) => sum + a.runs.reduce((rs, r) => rs + (r.totalCost ?? 0), 0),
    0,
  );

  const handleClearAll = async (e: React.MouseEvent) => {
    // Prevent the window click listener from immediately dismissing
    e.stopPropagation();
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
        {isConfirmingClear ? (
          <span
            style={{
              color: '#ef4444',
              fontSize: '12px',
            }}
          >
            Click again to delete all agents and runs
          </span>
        ) : (
          <span>
            {totalRuns} run{totalRuns !== 1 ? 's' : ''}
            {totalTokens > 0 &&
              ` · ${formatTokens(totalInputTokens)}↓ ${formatTokens(totalOutputTokens)}↑`}
            {totalCost > 0 && ` · $${totalCost.toFixed(4)}`}
          </span>
        )}
        <button
          type="button"
          onClick={handleClearAll}
          disabled={totalRuns === 0}
          title={isConfirmingClear ? 'Click again to confirm' : 'Clear all runs'}
          style={{
            width: '28px',
            height: '28px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '4px',
            border: isConfirmingClear ? '1px solid #ef4444' : '1px solid var(--noetic-border)',
            backgroundColor: isConfirmingClear ? '#ef444420' : 'var(--noetic-button-bg)',
            color: isConfirmingClear ? '#ef4444' : 'var(--noetic-text)',
            cursor: totalRuns === 0 ? 'not-allowed' : 'pointer',
            opacity: totalRuns === 0 ? 0.6 : 1,
            fontSize: '14px',
            padding: 0,
          }}
          onMouseEnter={(e) => {
            if (totalRuns > 0 && !isConfirmingClear) {
              e.currentTarget.style.backgroundColor = 'var(--noetic-button-hover)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = isConfirmingClear
              ? '#ef444420'
              : 'var(--noetic-button-bg)';
          }}
        >
          <svg
            width="14"
            height="14"
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
