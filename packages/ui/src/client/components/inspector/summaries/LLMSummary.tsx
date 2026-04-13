import type React from 'react';
import { useState } from 'react';
import { isLLMStepData } from '../../../types';
import { ChevronDown, ChevronRight, Terminal } from '../icons';
import type { SummaryRendererProps } from './registry';
import { registerSummaryRenderer } from './registry';

export const LLMSummary: React.FC<SummaryRendererProps> = ({ node }) => {
  if (!isLLMStepData(node.stepData)) {
    return null;
  }

  const { messages, toolCalls } = node.stepData;
  const systemMessage = messages.find((m) => m.role === 'system');

  return (
    <div className="space-y-3">
      {/* System Prompt */}
      {systemMessage && (
        <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 bg-[var(--noetic-accent)]/10 border-b border-[var(--noetic-border)]">
            <Terminal className="w-3.5 h-3.5 text-[var(--noetic-accent)]" />
            <span className="text-xs font-medium text-[var(--noetic-accent)]">System Prompt</span>
          </div>
          <div className="p-3 bg-[var(--noetic-code-bg)]">
            <pre className="text-xs font-mono text-[var(--noetic-text)] whitespace-pre-wrap break-words max-h-40 overflow-auto">
              {systemMessage.content}
            </pre>
          </div>
        </div>
      )}

      {/* Tool Calls */}
      {toolCalls.length > 0 && (
        <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 bg-orange-500/10 border-b border-[var(--noetic-border)]">
            <Terminal className="w-3.5 h-3.5 text-orange-500" />
            <span className="text-xs font-medium text-orange-500">
              Tool Calls ({toolCalls.length})
            </span>
          </div>
          <div className="p-3 space-y-2">
            {toolCalls.map((call) => (
              <ToolCallItem
                key={`${call.name}-${JSON.stringify(call.arguments)}`}
                name={call.name}
                arguments={call.arguments}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

//#region ToolCallItem

interface ToolCallItemProps {
  name: string;
  arguments: Record<string, unknown>;
}

const ToolCallItem: React.FC<ToolCallItemProps> = ({ name, arguments: args }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-[var(--noetic-border)] rounded overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2 py-1.5 bg-[var(--noetic-node-bg)] border-b border-[var(--noetic-border)] text-left hover:bg-[var(--noetic-hover)] transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-[var(--noetic-text-muted)]" />
        ) : (
          <ChevronRight className="w-3 h-3 text-[var(--noetic-text-muted)]" />
        )}
        <span className="text-xs font-medium font-mono text-[var(--noetic-text)]">{name}</span>
      </button>
      {expanded && (
        <pre className="text-xs font-mono text-[var(--noetic-text-secondary)] bg-[var(--noetic-code-bg)] p-2 max-h-32 overflow-auto whitespace-pre-wrap break-words">
          {JSON.stringify(args, null, 2)}
        </pre>
      )}
    </div>
  );
};

//#endregion

registerSummaryRenderer('llm', LLMSummary);
