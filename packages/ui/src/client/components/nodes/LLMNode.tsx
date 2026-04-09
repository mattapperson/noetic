/**
 * LLM Step Node Component
 * Displays an LLM step with model info and token usage
 */

import type React from 'react';
import type { ExecutionNode } from '../../types';
import { isLLMStepData } from '../../types';
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

interface LLMNodeProps {
  node: ExecutionNode;
  selected?: boolean;
  onClick?: () => void;
}

export const LLMNode: React.FC<LLMNodeProps> = ({ node, selected = false, onClick }) => {
  const baseStyles = getNodeBaseStyles('llm', node.status);
  const statusColors = STATUS_COLORS[node.status];
  const stepData = isLLMStepData(node.stepData) ? node.stepData : undefined;

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
    backgroundColor: 'rgba(139, 92, 246, 0.2)',
    color: '#8b5cf6',
  };

  const modelName = stepData?.model || 'Unknown Model';
  const tokenCount = stepData?.tokenUsage?.total || 0;
  const cost = stepData?.cost || 0;

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
          <span>{STEP_KIND_ICONS.llm}</span>
          <span>{STEP_KIND_LABELS.llm}</span>
        </div>
        <div style={statusBadgeStyles}>{STATUS_ICONS[node.status]}</div>
      </div>

      {/* Content */}
      <div style={nodeContentStyles}>
        <div style={titleStyles}>{node.title || 'LLM Step'}</div>
        <div style={idStyles}>{node.stepId}</div>

        {/* Model & Token Info */}
        <div
          style={{
            marginTop: '8px',
            display: 'flex',
            gap: '8px',
            flexWrap: 'wrap',
          }}
        >
          <span style={tagStyles}>{modelName}</span>
          {tokenCount > 0 && <span style={tagStyles}>{tokenCount.toLocaleString()} tokens</span>}
          {cost > 0 && <span style={tagStyles}>${cost.toFixed(4)}</span>}
        </div>
      </div>

      {/* Footer */}
      <div style={nodeFooterStyles}>
        <div>
          {tokenCount > 0 && (
            <span>{(stepData?.tokenUsage?.input ?? 0).toLocaleString()}↑ {(stepData?.tokenUsage?.output ?? 0).toLocaleString()}↓</span>
          )}
        </div>
        <div>{node.durationMs !== null && formatDuration(node.durationMs)}</div>
      </div>
    </button>
  );
};

export default LLMNode;
