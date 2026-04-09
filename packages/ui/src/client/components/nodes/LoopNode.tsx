/**
 * Loop Step Node Component
 * Displays a loop step with iteration count
 */

import type React from 'react';
import type { ExecutionNode } from '../../types';
import { isLoopStepData } from '../../types';
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

interface LoopNodeProps {
  node: ExecutionNode;
  selected?: boolean;
  onClick?: () => void;
}

export const LoopNode: React.FC<LoopNodeProps> = ({ node, selected = false, onClick }) => {
  const baseStyles = getNodeBaseStyles('loop', node.status);
  const statusColors = STATUS_COLORS[node.status];
  const stepData = isLoopStepData(node.stepData) ? node.stepData : undefined;

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
    backgroundColor: 'rgba(20, 184, 166, 0.2)',
    color: '#14b8a6',
  };

  const iteration = stepData?.iteration || 0;
  const totalIterations = stepData?.totalIterations;
  const maxIterations = stepData?.maxIterations;

  const iterationText = totalIterations
    ? `Iteration ${iteration}/${totalIterations}`
    : `Iteration ${iteration}`;

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
          <span>{STEP_KIND_ICONS.loop}</span>
          <span>{STEP_KIND_LABELS.loop}</span>
        </div>
        <div style={statusBadgeStyles}>{STATUS_ICONS[node.status]}</div>
      </div>

      {/* Content */}
      <div style={nodeContentStyles}>
        <div style={titleStyles}>{node.title || 'Loop'}</div>
        <div style={idStyles}>{node.stepId}</div>

        {/* Loop Info */}
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
              backgroundColor: 'rgba(20, 184, 166, 0.3)',
            }}
          >
            {iterationText}
          </span>
          {maxIterations && <span style={tagStyles}>Max: {maxIterations}</span>}
        </div>
      </div>

      {/* Footer */}
      <div style={nodeFooterStyles}>
        <div>{node.children.length > 0 && <span>{node.children.length} step(s)/iter</span>}</div>
        <div>{node.durationMs !== null && formatDuration(node.durationMs)}</div>
      </div>
    </button>
  );
};

export default LoopNode;
