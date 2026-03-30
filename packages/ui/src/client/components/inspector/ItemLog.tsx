import type React from 'react';
import { useState } from 'react';
import { prettyPrintJson, truncateString } from '../../lib/json-viewer';
import { ChevronDown, ChevronRight, Copy, Eye, EyeOff, MessageSquare } from './icons';

// Simple hash function for generating unique keys
const simpleHash = (str: string): string => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
};

export interface MessageItem {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface FunctionCallItem {
  name: string;
  arguments: Record<string, unknown>;
}

interface ItemLogProps {
  messages: MessageItem[];
  toolCalls?: FunctionCallItem[];
  model?: string;
}

export const ItemLog: React.FC<ItemLogProps> = ({ messages, toolCalls, model }) => {
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(
    new Set([
      0,
    ]),
  );
  const [showRaw, setShowRaw] = useState(false);

  const toggleMessage = (index: number) => {
    const newSet = new Set(expandedMessages);
    if (newSet.has(index)) {
      newSet.delete(index);
    } else {
      newSet.add(index);
    }
    setExpandedMessages(newSet);
  };

  const copyToClipboard = (content: string) => {
    navigator.clipboard.writeText(content);
  };

  return (
    <div className="space-y-2">
      {model && (
        <div className="flex items-center justify-between px-2 py-1.5 bg-[var(--noetic-node-bg)] rounded-md border border-[var(--noetic-border)]">
          <span className="text-xs text-[var(--noetic-text-muted)]">Model</span>
          <span className="text-xs font-mono text-[var(--noetic-text)]">{model}</span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--noetic-text)]">
          {messages.length} message{messages.length !== 1 ? 's' : ''}
        </span>
        <button
          type="button"
          onClick={() => setShowRaw(!showRaw)}
          className="flex items-center gap-1.5 text-xs text-[var(--noetic-text-secondary)] hover:text-[var(--noetic-text)] transition-colors"
        >
          {showRaw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          {showRaw ? 'Tree View' : 'Raw JSON'}
        </button>
      </div>

      {showRaw ? (
        <div className="relative">
          <pre className="text-xs font-mono text-[var(--noetic-text)] whitespace-pre-wrap break-all max-h-80 overflow-auto p-3 bg-[var(--noetic-code-bg)] rounded-lg border border-[var(--noetic-border)]">
            {prettyPrintJson(
              {
                messages,
                toolCalls,
              },
              2,
            )}
          </pre>
          <button
            type="button"
            onClick={() =>
              copyToClipboard(
                prettyPrintJson(
                  {
                    messages,
                    toolCalls,
                  },
                  2,
                ),
              )
            }
            className="absolute top-2 right-2 p-1.5 rounded bg-[var(--noetic-node-bg)] hover:bg-[var(--noetic-hover)] border border-[var(--noetic-border)] transition-colors"
            title="Copy to clipboard"
          >
            <Copy className="w-3.5 h-3.5 text-[var(--noetic-text-secondary)]" />
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {messages.map((message, index) => (
            <MessageCard
              key={simpleHash(`${message.role}-${message.content}`)}
              message={message}
              index={index}
              isExpanded={expandedMessages.has(index)}
              onToggle={() => toggleMessage(index)}
              onCopy={() => copyToClipboard(message.content)}
            />
          ))}

          {toolCalls && toolCalls.length > 0 && (
            <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden bg-[var(--noetic-node-bg)]">
              <div className="px-3 py-2 bg-[var(--noetic-accent)]/10 border-b border-[var(--noetic-border)]">
                <span className="text-xs font-medium text-[var(--noetic-accent)]">
                  Tool Calls ({toolCalls.length})
                </span>
              </div>
              <div className="p-3 space-y-2">
                {toolCalls.map((call) => (
                  <div
                    key={simpleHash(`${call.name}-${JSON.stringify(call.arguments)}`)}
                    className="p-2 rounded bg-[var(--noetic-code-bg)] border border-[var(--noetic-border)]"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-[var(--noetic-text)]">
                        {call.name}
                      </span>
                      <span className="text-xs text-[var(--noetic-text-muted)]">
                        Call {index + 1}
                      </span>
                    </div>
                    <pre className="text-xs font-mono text-[var(--noetic-text-secondary)] overflow-x-auto">
                      {prettyPrintJson(call.arguments, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface MessageCardProps {
  message: MessageItem;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  onCopy: () => void;
}

const MessageCard: React.FC<MessageCardProps> = ({
  message,
  index,
  isExpanded,
  onToggle,
  onCopy,
}) => {
  const roleColors: Record<MessageItem['role'], string> = {
    system: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
    user: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
    assistant: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
    tool: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  };

  const roleLabels: Record<MessageItem['role'], string> = {
    system: 'System',
    user: 'User',
    assistant: 'Assistant',
    tool: 'Tool',
  };

  const previewLength = 80;
  const needsExpansion = message.content.length > previewLength;
  const preview = truncateString(message.content, previewLength);

  return (
    <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden bg-[var(--noetic-node-bg)]">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--noetic-hover)] transition-colors"
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-[var(--noetic-text-muted)]" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-[var(--noetic-text-muted)]" />
          )}
          <MessageSquare className="w-3.5 h-3.5 text-[var(--noetic-text-muted)]" />
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded border ${roleColors[message.role]}`}
          >
            {roleLabels[message.role]}
          </span>
          <span className="text-xs text-[var(--noetic-text-muted)]">#{index + 1}</span>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCopy();
          }}
          className="p-1 rounded hover:bg-[var(--noetic-hover)] transition-colors"
          title="Copy message"
        >
          <Copy className="w-3 h-3 text-[var(--noetic-text-muted)]" />
        </button>
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 border-t border-[var(--noetic-border)]">
          <div className="pt-2">
            <pre className="text-xs font-mono text-[var(--noetic-text)] whitespace-pre-wrap break-words">
              {needsExpansion && !isExpanded ? preview : message.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
