import type React from 'react';
import { isToolStepData } from '../../../types';
import { Terminal } from '../icons';
import type { SummaryRendererProps } from './registry';
import { registerSummaryRenderer } from './registry';

export const ToolSummary: React.FC<SummaryRendererProps> = ({ node }) => {
  if (!isToolStepData(node.stepData)) {
    return null;
  }

  const { toolName, arguments: args, result } = node.stepData;

  return (
    <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-orange-500/10 border-b border-[var(--noetic-border)]">
        <Terminal className="w-3.5 h-3.5 text-orange-500" />
        <span className="text-xs font-medium text-orange-500">Tool: {toolName}</span>
      </div>
      <div className="p-3 space-y-3">
        <div>
          <p className="text-xs text-[var(--noetic-text-muted)] mb-1">Arguments</p>
          <pre className="text-xs font-mono text-[var(--noetic-text)] bg-[var(--noetic-code-bg)] p-2 rounded max-h-48 overflow-auto whitespace-pre-wrap break-words">
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
        <div>
          <p className="text-xs text-[var(--noetic-text-muted)] mb-1">Result</p>
          <pre className="text-xs font-mono text-[var(--noetic-text)] bg-[var(--noetic-code-bg)] p-2 rounded max-h-48 overflow-auto whitespace-pre-wrap break-words">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
};

registerSummaryRenderer('tool', ToolSummary);
