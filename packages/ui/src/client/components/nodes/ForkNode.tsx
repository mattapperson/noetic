/**
 * Fork Step Node Component
 * Displays a fork step with parallel execution paths
 */

import type React from 'react';
import type { ExecutionNode } from '../../types';
import { isForkStepData } from '../../types';
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

interface ForkNodeProps {
  node: ExecutionNode;
  selected?: boolean;
  onClick?: () => void;
}

export const ForkNode: React.FC<ForkNodeProps> = ({ node, selected = false, onClick }) => {
  const baseStyles = getNodeBaseStyles('fork', node.status);
  const statusColors = STATUS_COLORS[node.status];
  const stepData = isForkStepData(node.stepData) ? node.stepData : undefined;

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
    backgroundColor: 'rgba(236, 72, 153, 0.2)',
    color: '#ec4899',
  };

  const forkMode = stepData?.mode || 'all';
  const pathCount = stepData?.pathCount || node.children.length;
  const winnerPath = stepData?.winnerPath;

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
          <span>{STEP_KIND_ICONS.fork}</span>
          <span>{STEP_KIND_LABELS.fork}</span>
        </div>
        <div style={statusBadgeStyles}>{STATUS_ICONS[node.status]}</div>
      </div>

      {/* Content */}
      <div style={nodeContentStyles}>
        <div style={titleStyles}>{node.title || 'Fork'}</div>
        <div style={idStyles}>{node.stepId}</div>

        {/* Fork Info */}
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
              textTransform: 'uppercase',
            }}
          >
            {forkMode} mode
          </span>
          {winnerPath !== undefined && (
            <span
              style={{
                ...tagStyles,
                backgroundColor: 'rgba(236, 72, 153, 0.3)',
              }}
            >
              Winner: Path {winnerPath + 1}
            </span>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={nodeFooterStyles}>
        <div>{pathCount > 0 && <span>{pathCount} parallel path(s)</span>}</div>
        <div>{node.durationMs !== null && formatDuration(node.durationMs)}</div>
      </div>
    </button>
  );
};

export default ForkNode;
