/**
 * Run Step Node Component
 * Displays a run step with visual indicators for status and metadata
 */

import type React from 'react';
import type { ExecutionNode } from '../../types';
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

interface RunNodeProps {
  node: ExecutionNode;
  selected?: boolean;
  onClick?: () => void;
}

export const RunNode: React.FC<RunNodeProps> = ({ node, selected = false, onClick }) => {
  const baseStyles = getNodeBaseStyles('run', node.status);
  const statusColors = STATUS_COLORS[node.status];

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
    backgroundColor: 'rgba(6, 182, 212, 0.2)',
    color: '#06b6d4',
  };

  const attemptText =
    node.attemptCount && node.attemptCount > 1 ? `${node.attemptCount} attempts` : null;

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
          <span>{STEP_KIND_ICONS.run}</span>
          <span>{STEP_KIND_LABELS.run}</span>
        </div>
        <div style={statusBadgeStyles}>{STATUS_ICONS[node.status]}</div>
      </div>

      {/* Content */}
      <div style={nodeContentStyles}>
        <div style={titleStyles}>{node.title || 'Run Step'}</div>
        <div style={idStyles}>{node.stepId}</div>

        {/* Tags */}
        {node.stepData && 'description' in node.stepData && node.stepData.description && (
          <div
            style={{
              marginTop: '8px',
            }}
          >
            <span style={tagStyles}>{node.stepData.description}</span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={nodeFooterStyles}>
        <div>{attemptText && <span>{attemptText}</span>}</div>
        <div>{node.durationMs !== null && formatDuration(node.durationMs)}</div>
      </div>
    </button>
  );
};

export default RunNode;
