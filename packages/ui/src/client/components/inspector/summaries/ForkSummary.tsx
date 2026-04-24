import type React from 'react';
import { isForkStepData } from '../../../types';
import type { SummaryRendererProps } from './registry';
import { registerSummaryRenderer } from './registry';

//#region Mode Colors

const MODE_COLORS: Record<string, string> = {
  race: 'bg-yellow-500/10 text-yellow-500',
  all: 'bg-blue-500/10 text-blue-500',
  settle: 'bg-purple-500/10 text-purple-500',
};

//#endregion

export const ForkSummary: React.FC<SummaryRendererProps> = ({ node }) => {
  if (!isForkStepData(node.stepData)) {
    return null;
  }

  const { mode, pathCount, winnerPath } = node.stepData;

  return (
    <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-[var(--noetic-accent)]/10 border-b border-[var(--noetic-border)]">
        <span className="text-xs font-medium text-[var(--noetic-accent)]">Fork Status</span>
      </div>
      <div className="p-3 space-y-3">
        {/* Mode + Path Count */}
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded ${MODE_COLORS[mode] ?? 'bg-gray-500/10 text-gray-500'}`}
          >
            {mode.toUpperCase()}
          </span>
          <span className="text-xs text-[var(--noetic-text-muted)]">
            {pathCount} {pathCount === 1 ? 'path' : 'paths'}
          </span>
        </div>

        {/* Winner (race mode only) */}
        {mode === 'race' && winnerPath !== undefined && (
          <div>
            <p className="text-xs text-[var(--noetic-text-muted)] mb-1">Winner</p>
            <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded bg-green-500/10 text-green-500">
              Path {winnerPath}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

registerSummaryRenderer('fork', ForkSummary);
