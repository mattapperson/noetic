import type React from 'react';
import { isBranchStepData } from '../../../types';
import type { SummaryRendererProps } from './registry';
import { registerSummaryRenderer } from './registry';

export const BranchSummary: React.FC<SummaryRendererProps> = ({ node }) => {
  if (!isBranchStepData(node.stepData)) {
    return null;
  }

  const { condition, selectedPath } = node.stepData;

  return (
    <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-[var(--noetic-accent)]/10 border-b border-[var(--noetic-border)]">
        <span className="text-xs font-medium text-[var(--noetic-accent)]">Branch Config</span>
      </div>
      <div className="p-3 space-y-3">
        {/* Condition */}
        <div>
          <p className="text-xs text-[var(--noetic-text-muted)] mb-1">Condition</p>
          {condition ? (
            <pre className="text-xs font-mono text-[var(--noetic-text)] bg-[var(--noetic-code-bg)] p-2 rounded whitespace-pre-wrap break-words">
              {condition}
            </pre>
          ) : (
            <span className="text-xs italic text-[var(--noetic-text-muted)]">Implicit branch</span>
          )}
        </div>

        {/* Selected Path */}
        {selectedPath !== undefined && (
          <div>
            <p className="text-xs text-[var(--noetic-text-muted)] mb-1">Selected Path</p>
            <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded bg-[var(--noetic-accent)]/10 text-[var(--noetic-accent)]">
              Path {selectedPath}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

registerSummaryRenderer('branch', BranchSummary);
