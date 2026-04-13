import type React from 'react';
import { isLoopStepData } from '../../../types';
import { GroupedChildrenList } from '../ChildrenList';
import type { SummaryRendererProps } from './registry';
import { registerSummaryRenderer } from './registry';

export const LoopSummary: React.FC<SummaryRendererProps> = ({ node, nodes, onSelectNode }) => {
  if (!isLoopStepData(node.stepData)) {
    return null;
  }

  const { iteration, totalIterations, maxIterations } = node.stepData;
  const progressPercent = maxIterations > 0 ? Math.min((iteration / maxIterations) * 100, 100) : 0;

  return (
    <div className="space-y-3">
      <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-[var(--noetic-accent)]/10 border-b border-[var(--noetic-border)]">
          <span className="text-xs font-medium text-[var(--noetic-accent)]">Loop Progress</span>
        </div>
        <div className="p-3 space-y-3">
          {/* Progress Bar */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-[var(--noetic-text-muted)]">Progress</span>
              <span className="text-xs font-mono text-[var(--noetic-text)]">
                {iteration} / {maxIterations}
              </span>
            </div>
            <div className="w-full h-1.5 bg-[var(--noetic-border)] rounded-full overflow-hidden">
              <div
                className="h-full bg-[var(--noetic-accent)] rounded-full transition-all duration-300"
                style={{
                  width: `${progressPercent}%`,
                }}
              />
            </div>
          </div>

          {/* Total Iterations */}
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-[var(--noetic-text-muted)]">Total iterations:</span>
            <span className="text-xs font-mono text-[var(--noetic-text)]">{totalIterations}</span>
          </div>
        </div>
      </div>

      {/* Iteration-grouped children list */}
      {node.children.length > 0 && (
        <GroupedChildrenList
          childIds={node.children}
          nodes={nodes}
          totalIterations={totalIterations}
          onSelectNode={onSelectNode}
        />
      )}
    </div>
  );
};

registerSummaryRenderer('loop', LoopSummary);
