/**
 * Shared node styles and utilities for all step kind nodes
 */

import type React from 'react';
import type { ExecutionStatus, StepKind } from '../../types';

export const NODE_KIND_COLORS: Record<
  StepKind,
  {
    border: string;
    bg: string;
    text: string;
  }
> = {
  run: {
    border: '#06b6d4',
    bg: 'rgba(6, 182, 212, 0.1)',
    text: '#06b6d4',
  }, // cyan
  llm: {
    border: '#8b5cf6',
    bg: 'rgba(139, 92, 246, 0.1)',
    text: '#8b5cf6',
  }, // purple
  tool: {
    border: '#f97316',
    bg: 'rgba(249, 115, 22, 0.1)',
    text: '#f97316',
  }, // orange
  branch: {
    border: '#eab308',
    bg: 'rgba(234, 179, 8, 0.1)',
    text: '#eab308',
  }, // yellow
  fork: {
    border: '#ec4899',
    bg: 'rgba(236, 72, 153, 0.1)',
    text: '#ec4899',
  }, // pink
  spawn: {
    border: '#6366f1',
    bg: 'rgba(99, 102, 241, 0.1)',
    text: '#6366f1',
  }, // indigo
  loop: {
    border: '#14b8a6',
    bg: 'rgba(20, 184, 166, 0.1)',
    text: '#14b8a6',
  }, // teal
};

export const STATUS_COLORS: Record<
  ExecutionStatus,
  {
    border: string;
    bg: string;
    text: string;
  }
> = {
  completed: {
    border: '#10b981',
    bg: '#065f46',
    text: '#10b981',
  }, // green
  running: {
    border: '#3b82f6',
    bg: '#1e40af',
    text: '#3b82f6',
  }, // blue
  paused: {
    border: '#f59e0b',
    bg: '#92400e',
    text: '#f59e0b',
  }, // yellow
  error: {
    border: '#ef4444',
    bg: '#991b1b',
    text: '#ef4444',
  }, // red
  pending: {
    border: '#6b7280',
    bg: '#374151',
    text: '#9ca3af',
  }, // gray
  cancelled: {
    border: '#6b7280',
    bg: '#374151',
    text: '#9ca3af',
  }, // gray
};

export const STATUS_LABELS: Record<ExecutionStatus, string> = {
  completed: 'DONE',
  running: 'RUNNING',
  paused: 'PAUSED',
  error: 'ERROR',
  pending: 'QUEUED',
  cancelled: 'CANCELLED',
};

export const STEP_KIND_ICONS: Record<StepKind, string> = {
  run: '⚡',
  llm: '💬',
  tool: '🔧',
  branch: '🔀',
  fork: '⫚',
  spawn: '📦',
  loop: '🔄',
};

export const STEP_KIND_LABELS: Record<StepKind, string> = {
  run: 'RUN',
  llm: 'LLM',
  tool: 'TOOL',
  branch: 'BRANCH',
  fork: 'FORK',
  spawn: 'SPAWN',
  loop: 'LOOP',
};

export function formatDuration(ms: number | null): string {
  if (ms === null) {
    return '';
  }

  if (ms < 1000) {
    return `${ms.toFixed(0)} ms`;
  }

  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }

  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function getNodeBaseStyles(kind: StepKind, status: ExecutionStatus): React.CSSProperties {
  const kindColors = NODE_KIND_COLORS[kind];
  const statusColors = STATUS_COLORS[status];

  return {
    width: '280px',
    minHeight: '120px',
    borderRadius: '8px',
    border: `2px solid ${status === 'pending' ? kindColors.border : statusColors.border}`,
    backgroundColor: status === 'pending' ? 'rgba(30, 41, 59, 0.8)' : statusColors.bg,
    boxShadow: `0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06), 0 0 0 1px ${status === 'pending' ? kindColors.border : statusColors.border}40`,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    position: 'relative',
    overflow: 'hidden',
  };
}

export const nodeHeaderStyles: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 16px',
  borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
};

export const nodeContentStyles: React.CSSProperties = {
  padding: '12px 16px',
};

export const nodeFooterStyles: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 16px',
  borderTop: '1px solid rgba(255, 255, 255, 0.1)',
  fontSize: '12px',
  color: '#94a3b8',
};

export const badgeStyles: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '4px 8px',
  borderRadius: '4px',
  fontSize: '11px',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

export const titleStyles: React.CSSProperties = {
  fontSize: '14px',
  fontWeight: 600,
  color: '#f1f5f9',
  marginBottom: '4px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export const idStyles: React.CSSProperties = {
  fontSize: '11px',
  fontFamily: 'monospace',
  color: '#94a3b8',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export const tagStyles: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 6px',
  borderRadius: '3px',
  fontSize: '10px',
  backgroundColor: 'rgba(255, 255, 255, 0.1)',
  color: '#cbd5e1',
  marginRight: '4px',
  marginBottom: '4px',
};

export function getRunningAnimationStyles(): React.CSSProperties {
  return {
    animation: 'pulse-border 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
  };
}

export function getSelectedStyles(): React.CSSProperties {
  return {
    boxShadow: '0 0 0 3px rgba(59, 130, 246, 0.5), 0 4px 6px -1px rgba(0, 0, 0, 0.1)',
  };
}
