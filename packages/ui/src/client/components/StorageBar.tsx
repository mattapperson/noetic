/**
 * Storage bar component
 * Displays storage usage with visual indicator and delete controls
 */

import type React from 'react';
import { useState } from 'react';
import { useAgentStore } from '../stores/agent';
import { useStorageStore } from '../stores/storage';

interface StorageBarProps {
  onClearAll?: () => void;
}

export const StorageBar: React.FC<StorageBarProps> = ({ onClearAll }) => {
  const {
    metrics,
    getTotalUsagePercent,
    getWarningLevel,
    getFormattedTotalSize,
    getFormattedAvailable,
  } = useStorageStore();
  const { agents, removeAllRuns } = useAgentStore();
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);

  const usagePercent = getTotalUsagePercent();
  const warningLevel = getWarningLevel();
  const totalSize = getFormattedTotalSize();
  const available = getFormattedAvailable();

  const getBarColor = () => {
    if (warningLevel.level === 'critical') {
      return '#ef4444'; // red-500
    }
    if (warningLevel.level === 'warning') {
      return '#f97316'; // orange-500
    }
    return '#3b82f6'; // blue-500
  };

  const handleClearAll = () => {
    if (isConfirmingClear) {
      // Clear all runs for all agents
      agents.forEach((agent) => {
        removeAllRuns(agent.id);
      });
      if (onClearAll) {
        onClearAll();
      }
      setIsConfirmingClear(false);
    } else {
      setIsConfirmingClear(true);
      // Auto-cancel after 3 seconds
      setTimeout(() => {
        setIsConfirmingClear(false);
      }, 3000);
    }
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
          {metrics.totalRuns} run{metrics.totalRuns !== 1 ? 's' : ''} · {totalSize} used ·{' '}
          {available} available
        </span>
        <span
          style={{
            fontWeight: 600,
            color: warningLevel.level !== 'normal' ? getBarColor() : 'var(--noetic-text)',
          }}
        >
          {usagePercent.toFixed(1)}%
        </span>
      </div>

      {/* Storage bar */}
      <button
        type="button"
        onClick={() => setShowBreakdown(!showBreakdown)}
        style={{
          height: '6px',
          width: '100%',
          backgroundColor: 'var(--noetic-border)',
          borderRadius: '3px',
          overflow: 'hidden',
          marginBottom: '8px',
          cursor: 'pointer',
          padding: 0,
          border: 'none',
          position: 'relative',
        }}
        title="Click for storage breakdown"
      >
        <div
          style={{
            height: '100%',
            width: `${Math.min(usagePercent, 100)}%`,
            backgroundColor: getBarColor(),
            borderRadius: '3px',
            transition: 'width 0.3s ease',
          }}
        />
      </button>

      {/* Warning message */}
      {warningLevel.message && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 8px',
            marginBottom: '8px',
            backgroundColor: `${getBarColor()}15`,
            border: `1px solid ${getBarColor()}40`,
            borderRadius: '4px',
            fontSize: '10px',
            color: getBarColor(),
          }}
        >
          <span>⚠️</span>
          <span>{warningLevel.message}</span>
        </div>
      )}

      {/* Storage breakdown */}
      {showBreakdown && (
        <div
          style={{
            marginBottom: '8px',
            padding: '8px',
            backgroundColor: 'var(--noetic-input-bg)',
            borderRadius: '4px',
            fontSize: '10px',
          }}
        >
          <div
            style={{
              fontWeight: 600,
              marginBottom: '6px',
              color: 'var(--noetic-text)',
            }}
          >
            Storage Breakdown
          </div>
          {Array.from(metrics.byAgent.entries()).map(([agentId, info]) => {
            const agent = agents.find((a) => a.id === agentId);
            if (!agent) {
              return null;
            }
            return (
              <div
                key={agentId}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '4px 0',
                  borderBottom: '1px solid var(--noetic-border)',
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '70%',
                    color: 'var(--noetic-text-secondary)',
                  }}
                  title={agent.name}
                >
                  {agent.name}
                </span>
                <span
                  style={{
                    color: 'var(--noetic-text-muted)',
                  }}
                >
                  {info.runCount} runs ·
                  {info.sizeBytes < 1024 * 1024
                    ? `${(info.sizeBytes / 1024).toFixed(1)} KB`
                    : `${(info.sizeBytes / (1024 * 1024)).toFixed(1)} MB`}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Actions */}
      <div
        style={{
          display: 'flex',
          gap: '8px',
        }}
      >
        <button
          type="button"
          onClick={handleClearAll}
          disabled={metrics.totalRuns === 0}
          style={{
            flex: 1,
            padding: '6px 10px',
            fontSize: '11px',
            borderRadius: '4px',
            border: isConfirmingClear ? '1px solid #ef4444' : '1px solid var(--noetic-border)',
            backgroundColor: isConfirmingClear ? '#ef444420' : 'var(--noetic-button-bg)',
            color: isConfirmingClear ? '#ef4444' : 'var(--noetic-text)',
            cursor: metrics.totalRuns === 0 ? 'not-allowed' : 'pointer',
            opacity: metrics.totalRuns === 0 ? 0.5 : 1,
            transition: 'all 0.15s',
          }}
        >
          {isConfirmingClear ? 'Click again to confirm' : '🗑 Clear all runs'}
        </button>
      </div>

      {/* Export hint */}
      <div
        style={{
          marginTop: '8px',
          fontSize: '9px',
          color: 'var(--noetic-text-muted)',
          textAlign: 'center',
        }}
      >
        Right-click a run to export before deleting
      </div>
    </div>
  );
};

export default StorageBar;
