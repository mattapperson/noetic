import type React from 'react';
import { useState } from 'react';
import { isLLMStepData } from '../../../types';
import { ChevronDown, ChevronRight, Copy, Terminal } from '../icons';
import type { SummaryRendererProps } from './registry';
import { registerSummaryRenderer } from './registry';

const simpleHash = (str: string): string => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
};

export const LLMSummary: React.FC<SummaryRendererProps> = ({ node }) => {
  if (!isLLMStepData(node.stepData)) {
    return null;
  }

  const { messages, toolCalls, payloadMessages } = node.stepData;
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

      {/* Payload Messages (all messages sent in the request) */}
      {payloadMessages && payloadMessages.length > 0 && <PayloadMessages items={payloadMessages} />}
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

//#region PayloadMessages

/** Extract a display-friendly role from an Item object. */
function extractRole(item: unknown): string {
  if (typeof item !== 'object' || item === null) {
    return 'unknown';
  }
  const obj = item as Record<string, unknown>;
  if (typeof obj.role === 'string') {
    return obj.role;
  }
  if (typeof obj.type === 'string') {
    return obj.type;
  }
  return 'unknown';
}

/** Extract a short text preview from an Item object. */
function extractPreview(item: unknown, maxLen: number): string {
  if (typeof item !== 'object' || item === null) {
    return String(item);
  }
  const obj = item as Record<string, unknown>;

  // InputMessageItem / MessageItem with content array
  if (Array.isArray(obj.content)) {
    for (const part of obj.content) {
      if (typeof part === 'object' && part !== null) {
        const p = part as Record<string, unknown>;
        if (typeof p.text === 'string') {
          return p.text.length > maxLen ? `${p.text.slice(0, maxLen)}...` : p.text;
        }
      }
    }
  }

  // FunctionCallItem
  if (typeof obj.name === 'string' && obj.type === 'function_call') {
    return `${obj.name}(...)`;
  }

  // FunctionCallOutputItem
  if (obj.type === 'function_call_output' && typeof obj.output === 'string') {
    return obj.output.length > maxLen ? `${obj.output.slice(0, maxLen)}...` : obj.output;
  }

  return JSON.stringify(item).slice(0, maxLen);
}

const ROLE_COLORS: Record<string, string> = {
  system: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  user: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  developer: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  assistant: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  function_call: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  function_call_output: 'bg-teal-500/10 text-teal-500 border-teal-500/20',
  message: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
};

interface PayloadMessagesProps {
  items: unknown[];
}

const PayloadMessages: React.FC<PayloadMessagesProps> = ({ items }) => {
  const [expanded, setExpanded] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());

  const toggleItem = (index: number): void => {
    const next = new Set(expandedItems);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    setExpandedItems(next);
  };

  const copyAll = (): void => {
    navigator.clipboard.writeText(JSON.stringify(items, null, 2));
  };

  return (
    <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 bg-cyan-500/10 border-b border-[var(--noetic-border)] hover:bg-cyan-500/15 transition-colors"
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-cyan-500" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-cyan-500" />
          )}
          <span className="text-xs font-medium text-cyan-500">
            Payload Messages ({items.length})
          </span>
        </div>
        {expanded && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              copyAll();
            }}
            className="p-1 rounded hover:bg-[var(--noetic-hover)] transition-colors"
            title="Copy all payload messages"
          >
            <Copy className="w-3 h-3 text-cyan-500" />
          </button>
        )}
      </button>

      {expanded && (
        <div className="p-3 space-y-1.5 max-h-96 overflow-auto">
          {items.map((item, index) => {
            const role = extractRole(item);
            const isItemExpanded = expandedItems.has(index);
            const colorClass = ROLE_COLORS[role] ?? ROLE_COLORS.message;

            return (
              <div
                key={simpleHash(`${role}-${extractPreview(item, 120)}`)}
                className="border border-[var(--noetic-border)] rounded overflow-hidden bg-[var(--noetic-node-bg)]"
              >
                <button
                  type="button"
                  onClick={() => toggleItem(index)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--noetic-hover)] transition-colors"
                >
                  {isItemExpanded ? (
                    <ChevronDown className="w-3 h-3 text-[var(--noetic-text-muted)] flex-shrink-0" />
                  ) : (
                    <ChevronRight className="w-3 h-3 text-[var(--noetic-text-muted)] flex-shrink-0" />
                  )}
                  <span
                    className={`text-xs font-medium px-1.5 py-0.5 rounded border flex-shrink-0 ${colorClass}`}
                  >
                    {role}
                  </span>
                  <span className="text-xs text-[var(--noetic-text-muted)] truncate">
                    {extractPreview(item, 60)}
                  </span>
                </button>
                {isItemExpanded && (
                  <div className="px-2 pb-2 border-t border-[var(--noetic-border)]">
                    <pre className="text-xs font-mono text-[var(--noetic-text)] whitespace-pre-wrap break-words pt-2 max-h-48 overflow-auto">
                      {JSON.stringify(item, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

//#endregion

registerSummaryRenderer('llm', LLMSummary);
