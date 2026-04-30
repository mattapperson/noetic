/**
 * Every Step Node Component
 * Displays a recurring `every` operator with park duration and jitter
 */

import type React from 'react';
import type { ExecutionNode } from '../../types';
import { isEveryStepData } from '../../types';
import {
  badgeStyles,
  formatDuration,
  getNodeBaseStyles,
  getRunningAnimationStyles,
  getSelectedStyles,
  idStyles,
  nodeContentStyles,
  nodeFooterStyles,
  nodeHeaderStyles,
  STATUS_COLORS,
  STATUS_ICONS,
  STEP_KIND_ICONS,
  STEP_KIND_LABELS,
  tagStyles,
  titleStyles,
} from './shared';

interface EveryNodeProps {
  node: ExecutionNode;
  selected?: boolean;
  onClick?: () => void;
}

function formatPark(ms: number, jitter: number): string {
  const base = ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  if (jitter <= 0) {
    return `every ${base}`;
  }
  const jitterStr = jitter < 1000 ? `${jitter} ms` : `${(jitter / 1000).toFixed(1)} s`;
  return `every ${base} ±${jitterStr}`;
}

export const EveryNode: React.FC<EveryNodeProps> = ({ node, selected = false, onClick }) => {
  const baseStyles = getNodeBaseStyles('every', node.status);
  const statusColors = STATUS_COLORS[node.status];
  const stepData = isEveryStepData(node.stepData) ? node.stepData : undefined;

  const styles: React.CSSProperties = {
    ...baseStyles,
    ...(node.status === 'running' ? getRunningAnimationStyles() : {}),
    ...(selected ? getSelectedStyles() : {}),
  };

  const statusBadgeStyles: React.CSSProperties = {
    ...badgeStyles,
    backgroundColor: statusColors.bg,
    color: statusColors.text,
  };

  const kindBadgeStyles: React.CSSProperties = {
    ...badgeStyles,
    backgroundColor: 'rgba(34, 211, 238, 0.2)',
    color: '#22d3ee',
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.();
    }
  };

  return (
    <button type="button" style={styles} onClick={onClick} onKeyDown={handleKeyDown}>
      {/* Header */}
      <div style={nodeHeaderStyles}>
        <div style={kindBadgeStyles}>
          <span>{STEP_KIND_ICONS.every}</span>
          <span>{STEP_KIND_LABELS.every}</span>
        </div>
        <div style={statusBadgeStyles}>{STATUS_ICONS[node.status]}</div>
      </div>

      {/* Content */}
      <div style={nodeContentStyles}>
        <div style={titleStyles}>{node.title || 'Every'}</div>
        <div style={idStyles}>{node.stepId}</div>

        {stepData && (
          <div
            style={{
              marginTop: '8px',
              display: 'flex',
              gap: '8px',
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                ...tagStyles,
                backgroundColor: 'rgba(34, 211, 238, 0.3)',
              }}
            >
              {formatPark(stepData.ms, stepData.jitter)}
            </span>
            {stepData.wakeOn && <span style={tagStyles}>wake: {stepData.wakeOn}</span>}
            {stepData.onError === 'fail' && (
              <span
                style={{
                  ...tagStyles,
                  backgroundColor: 'rgba(239, 68, 68, 0.3)',
                  color: '#ef4444',
                }}
              >
                fail-fast
              </span>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={nodeFooterStyles}>
        <div>{node.children.length > 0 && <span>{node.children.length} iteration(s)</span>}</div>
        <div>{node.durationMs !== null && formatDuration(node.durationMs)}</div>
      </div>
    </button>
  );
};

export default EveryNode;
