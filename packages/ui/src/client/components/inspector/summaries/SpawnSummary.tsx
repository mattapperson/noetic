import type React from 'react';
import { isSpawnStepData } from '../../../types';
import type { SummaryRendererProps } from './registry';
import { registerSummaryRenderer } from './registry';

//#region Kind Labels

const KIND_LABELS: Record<string, string> = {
  run: 'RUN',
  llm: 'LLM',
  tool: 'TOOL',
  branch: 'BRANCH',
  fork: 'FORK',
  spawn: 'SPAWN',
  loop: 'LOOP',
};

//#endregion

export const SpawnSummary: React.FC<SummaryRendererProps> = ({ node, onSelectNode }) => {
  if (!isSpawnStepData(node.stepData)) {
    return null;
  }

  const { childStepId, childStepKind } = node.stepData;

  return (
    <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-[var(--noetic-accent)]/10 border-b border-[var(--noetic-border)]">
        <span className="text-xs font-medium text-[var(--noetic-accent)]">Spawned Step</span>
      </div>
      <div className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded bg-[var(--noetic-accent)]/10 text-[var(--noetic-accent)]">
            {KIND_LABELS[childStepKind] ?? childStepKind.toUpperCase()}
          </span>
          {onSelectNode ? (
            <button
              type="button"
              onClick={() => onSelectNode(childStepId)}
              className="text-xs font-mono text-[var(--noetic-accent)] hover:underline truncate"
              title={`Navigate to ${childStepId}`}
            >
              {childStepId}
            </button>
          ) : (
            <span className="text-xs font-mono text-[var(--noetic-text)] truncate">
              {childStepId}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

registerSummaryRenderer('spawn', SpawnSummary);
