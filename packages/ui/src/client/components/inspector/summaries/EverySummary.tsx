import type React from 'react';
import { isEveryStepData } from '../../../types';
import { GroupedChildrenList } from '../ChildrenList';
import type { SummaryRendererProps } from './registry';
import { registerSummaryRenderer } from './registry';

function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(2)} s`;
  }
  return `${(ms / 60_000).toFixed(2)} min`;
}

export const EverySummary: React.FC<SummaryRendererProps> = ({ node, nodes, onSelectNode }) => {
  if (!isEveryStepData(node.stepData)) {
    return null;
  }

  const { ms, jitter, onError, bodyStepId, bodyStepKind, wakeOn } = node.stepData;
  const iterations = node.children.length;

  return (
    <div className="space-y-3">
      <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-[var(--noetic-accent)]/10 border-b border-[var(--noetic-border)]">
          <span className="text-xs font-medium text-[var(--noetic-accent)]">Every</span>
        </div>
        <div className="p-3 space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-[var(--noetic-text-muted)]">Park:</span>
            <span className="text-xs font-mono text-[var(--noetic-text)]">
              {formatMs(ms)}
              {jitter > 0 ? ` ±${formatMs(jitter)}` : ''}
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-[var(--noetic-text-muted)]">Body:</span>
            <span className="text-xs font-mono text-[var(--noetic-text)]">
              {bodyStepKind} <span className="text-[var(--noetic-text-muted)]">({bodyStepId})</span>
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-[var(--noetic-text-muted)]">On error:</span>
            <span className="text-xs font-mono text-[var(--noetic-text)]">{onError}</span>
          </div>
          {wakeOn && (
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-[var(--noetic-text-muted)]">Wake on:</span>
              <span className="text-xs font-mono text-[var(--noetic-text)]">{wakeOn}</span>
            </div>
          )}
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-[var(--noetic-text-muted)]">Iterations:</span>
            <span className="text-xs font-mono text-[var(--noetic-text)]">{iterations}</span>
          </div>
        </div>
      </div>

      {node.children.length > 0 && (
        <GroupedChildrenList
          childIds={node.children}
          nodes={nodes}
          totalIterations={iterations}
          onSelectNode={onSelectNode}
        />
      )}
    </div>
  );
};

registerSummaryRenderer('every', EverySummary);
