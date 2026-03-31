/**
 * Tool Step Node Component
 * Displays a tool invocation with tool name and arguments
 */

import type React from 'react';
import type { ExecutionNode } from '../../types';
import { isToolStepData } from '../../types';
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
  STATUS_LABELS,
  STEP_KIND_ICONS,
  STEP_KIND_LABELS,
  tagStyles,
  titleStyles,
} from './shared';

interface ToolNodeProps {
  node: ExecutionNode;
  selected?: boolean;
  onClick?: () => void;
}

export const ToolNode: React.FC<ToolNodeProps> = ({ node, selected = false, onClick }) => {
  const baseStyles = getNodeBaseStyles('tool', node.status);
  const statusColors = STATUS_COLORS[node.status];
  const stepData = isToolStepData(node.stepData) ? node.stepData : undefined;

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
    backgroundColor: 'rgba(249, 115, 22, 0.2)',
    color: '#f97316',
  };

  const toolName = stepData?.toolName || 'Unknown Tool';

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
          <span>{STEP_KIND_ICONS.tool}</span>
          <span>{STEP_KIND_LABELS.tool}</span>
        </div>
        <div style={statusBadgeStyles}>{STATUS_LABELS[node.status]}</div>
      </div>

      {/* Content */}
      <div style={nodeContentStyles}>
        <div style={titleStyles}>{toolName}</div>
        <div style={idStyles}>{node.stepId}</div>

        {/* Tool Args Preview */}
        {stepData?.arguments !== undefined && stepData?.arguments !== null && (
          <div
            style={{
              marginTop: '8px',
            }}
          >
            <span style={tagStyles}>
              {typeof stepData.arguments === 'object'
                ? JSON.stringify(stepData.arguments).slice(0, 50) + '...'
                : String(stepData.arguments)}
            </span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={nodeFooterStyles}>
        <div />
        <div>{node.durationMs !== null && formatDuration(node.durationMs)}</div>
      </div>
    </button>
  );
};

export default ToolNode;
