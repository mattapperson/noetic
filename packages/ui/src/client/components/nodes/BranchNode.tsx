/**
 * Branch Step Node Component
 * Displays a branch/conditional step
 */

import type React from 'react';
import type { ExecutionNode } from '../../types';
import { isBranchStepData } from '../../types';
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
  STATUS_LABELS,
  STEP_KIND_ICONS,
  STEP_KIND_LABELS,
  tagStyles,
  titleStyles,
} from './shared';

interface BranchNodeProps {
  node: ExecutionNode;
  selected?: boolean;
  onClick?: () => void;
}

export const BranchNode: React.FC<BranchNodeProps> = ({ node, selected = false, onClick }) => {
  const baseStyles = getNodeBaseStyles('branch', node.status);
  const statusColors = STATUS_COLORS[node.status];
  const stepData = isBranchStepData(node.stepData) ? node.stepData : undefined;

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
    backgroundColor: 'rgba(234, 179, 8, 0.2)',
    color: '#eab308',
  };

  const selectedPath = stepData?.selectedPath;

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
          <span>{STEP_KIND_ICONS.branch}</span>
          <span>{STEP_KIND_LABELS.branch}</span>
        </div>
        <div style={statusBadgeStyles}>{STATUS_ICONS[node.status]}</div>
      </div>

      {/* Content */}
      <div style={nodeContentStyles}>
        <div style={titleStyles}>{node.title || 'Branch'}</div>
        <div style={idStyles}>{node.stepId}</div>

        {/* Branch Info */}
        <div
          style={{
            marginTop: '8px',
            display: 'flex',
            gap: '8px',
            flexWrap: 'wrap',
          }}
        >
          {stepData?.condition && <span style={tagStyles}>{stepData.condition}</span>}
          {selectedPath !== undefined && (
            <span
              style={{
                ...tagStyles,
                backgroundColor: 'rgba(234, 179, 8, 0.3)',
              }}
            >
              Path {selectedPath + 1}
            </span>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={nodeFooterStyles}>
        <div>{node.children.length > 0 && <span>{node.children.length} path(s)</span>}</div>
        <div>{node.durationMs !== null && formatDuration(node.durationMs)}</div>
      </div>
    </button>
  );
};

export default BranchNode;
