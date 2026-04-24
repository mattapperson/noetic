/**
 * Spawn Step Node Component
 * Displays a spawn step with child context information
 */

import type React from 'react';
import type { ExecutionNode } from '../../types';
import { isSpawnStepData } from '../../types';
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

interface SpawnNodeProps {
  node: ExecutionNode;
  selected?: boolean;
  onClick?: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
}

export const SpawnNode: React.FC<SpawnNodeProps> = ({
  node,
  selected = false,
  onClick,
  expanded = false,
  onToggleExpand,
}) => {
  const baseStyles = getNodeBaseStyles('spawn', node.status);
  const statusColors = STATUS_COLORS[node.status];
  const stepData = isSpawnStepData(node.stepData) ? node.stepData : undefined;

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
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    color: '#6366f1',
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.();
    }
  };

  const hasChildren = node.children.length > 0;

  return (
    <button type="button" style={styles} onClick={onClick} onKeyDown={handleKeyDown}>
      {/* Header */}
      <div style={nodeHeaderStyles}>
        <div style={kindBadgeStyles}>
          <span>{STEP_KIND_ICONS.spawn}</span>
          <span>{STEP_KIND_LABELS.spawn}</span>
        </div>
        <div style={statusBadgeStyles}>{STATUS_ICONS[node.status]}</div>
      </div>

      {/* Content */}
      <div style={nodeContentStyles}>
        <div style={titleStyles}>{node.title || 'Spawn'}</div>
        <div style={idStyles}>{node.stepId}</div>

        {/* Spawn Info */}
        <div
          style={{
            marginTop: '8px',
            display: 'flex',
            gap: '8px',
            flexWrap: 'wrap',
          }}
        >
          {stepData?.childStepKind && (
            <span style={tagStyles}>Child: {stepData.childStepKind}</span>
          )}
          {hasChildren && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand?.();
              }}
              style={{
                ...tagStyles,
                cursor: 'pointer',
                backgroundColor: expanded ? 'rgba(99, 102, 241, 0.3)' : undefined,
              }}
            >
              {expanded ? '▼' : '▶'} {node.children.length} child(s)
            </button>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={nodeFooterStyles}>
        <div>
          <span>Depth {node.depth}</span>
        </div>
        <div>{node.durationMs !== null && formatDuration(node.durationMs)}</div>
      </div>
    </button>
  );
};

export default SpawnNode;
