import type React from 'react';
import { useState } from 'react';
import { useExecutionStore } from '../stores/execution';
import type { ExecutionNode, LLMStepData, ToolStepData } from '../types';
import { ContextState } from './inspector/ContextState';
import { InputOutput } from './inspector/InputOutput';
import { ItemLog } from './inspector/ItemLog';
import { AlertCircle, Terminal } from './inspector/icons';
import { RawTrace } from './inspector/RawTrace';
import type { TabId } from './inspector/Tabs';
import { InspectorTabs } from './inspector/Tabs';

// Type guard functions to avoid type casting
const isLLMNode = (
  node: ExecutionNode,
): node is ExecutionNode & {
  stepData: LLMStepData;
} => {
  return node.kind === 'llm' && 'messages' in node.stepData;
};

const isToolNode = (
  node: ExecutionNode,
): node is ExecutionNode & {
  stepData: ToolStepData;
} => {
  return node.kind === 'tool' && 'toolName' in node.stepData;
};

export const NodeInspector: React.FC = () => {
  const { selectedNode, traces } = useExecutionStore();
  const [activeTab, setActiveTab] = useState<TabId>('session');
  const [detailMode, setDetailMode] = useState<'follow' | 'overview'>('follow');

  if (!selectedNode) {
    return (
      <div className="w-full h-full border-l border-[var(--noetic-border)] bg-[var(--noetic-sidebar-bg)] flex flex-col">
        <div className="p-4 border-b border-[var(--noetic-border)]">
          <h2 className="text-sm font-semibold text-[var(--noetic-text)]">Inspector</h2>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-sm text-[var(--noetic-text-muted)] text-center">
            Click a node in the canvas to inspect its details
          </p>
        </div>
      </div>
    );
  }

  const trace = selectedNode ? traces.get(selectedNode.id) : undefined;

  return (
    <div className="w-full h-full border-l border-[var(--noetic-border)] bg-[var(--noetic-sidebar-bg)] flex flex-col">
      <InspectorTabs activeTab={activeTab} onTabChange={setActiveTab} />

      <div className="flex-1 overflow-auto">
        <div className="p-4 space-y-4">
          {/* Node Header */}
          <NodeHeader node={selectedNode} detailMode={detailMode} onModeChange={setDetailMode} />

          {/* Tab Content */}
          {activeTab === 'session' && (
            <div className="space-y-4">
              {/* System Prompt (for LLM steps) */}
              {isLLMNode(selectedNode) && <SystemPrompt stepData={selectedNode.stepData} />}

              {/* Input/Output */}
              <InputOutput
                input={selectedNode.input}
                output={selectedNode.output}
                title="Data Flow"
              />

              {/* Context State */}
              <ContextState snapshot={selectedNode.contextSnapshot} />
            </div>
          )}

          {activeTab === 'attempt' && (
            <div className="space-y-4">
              <AttemptDetails node={selectedNode} />

              {/* Item Log (for LLM steps) */}
              {isLLMNode(selectedNode) && (
                <ItemLog
                  messages={selectedNode.stepData.messages}
                  toolCalls={selectedNode.stepData.toolCalls}
                  model={selectedNode.stepData.model}
                />
              )}

              {/* Tool result (for tool steps) */}
              {isToolNode(selectedNode) && <ToolResult stepData={selectedNode.stepData} />}
            </div>
          )}

          {activeTab === 'events' && (
            <div className="space-y-4">
              <RawTrace node={selectedNode} trace={trace} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface NodeHeaderProps {
  node: ReturnType<typeof useExecutionStore.getState>['selectedNode'];
  detailMode: 'follow' | 'overview';
  onModeChange: (mode: 'follow' | 'overview') => void;
}

const NodeHeader: React.FC<NodeHeaderProps> = ({ node, detailMode, onModeChange }) => {
  if (!node) {
    return null;
  }

  const statusColors: Record<string, string> = {
    completed: 'bg-green-500',
    running: 'bg-blue-500 animate-pulse',
    error: 'bg-red-500',
    paused: 'bg-yellow-500',
    pending: 'bg-gray-400',
    cancelled: 'bg-gray-500',
  };

  const kindLabels: Record<string, string> = {
    run: 'RUN',
    llm: 'LLM',
    tool: 'TOOL',
    branch: 'BRANCH',
    fork: 'FORK',
    spawn: 'SPAWN',
    loop: 'LOOP',
  };

  return (
    <div className="border border-[var(--noetic-border)] rounded-lg p-3 bg-[var(--noetic-node-bg)]">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${statusColors[node.status] || 'bg-gray-400'}`} />
          <span className="text-xs font-medium px-2 py-0.5 rounded bg-[var(--noetic-accent)]/10 text-[var(--noetic-accent)]">
            {kindLabels[node.kind] || node.kind.toUpperCase()}
          </span>
        </div>
        <div className="flex items-center gap-1 bg-[var(--noetic-border)] rounded-md p-0.5">
          <button
            type="button"
            onClick={() => onModeChange('follow')}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              detailMode === 'follow'
                ? 'bg-[var(--noetic-node-bg)] text-[var(--noetic-text)]'
                : 'text-[var(--noetic-text-muted)] hover:text-[var(--noetic-text)]'
            }`}
          >
            Follow
          </button>
          <button
            type="button"
            onClick={() => onModeChange('overview')}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              detailMode === 'overview'
                ? 'bg-[var(--noetic-node-bg)] text-[var(--noetic-text)]'
                : 'text-[var(--noetic-text-muted)] hover:text-[var(--noetic-text)]'
            }`}
          >
            Overview
          </button>
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium text-[var(--noetic-text)] truncate">{node.stepId}</p>
        <p className="text-xs text-[var(--noetic-text-muted)] font-mono truncate">ID: {node.id}</p>
      </div>

      <div className="mt-3 pt-2 border-t border-[var(--noetic-border)] flex items-center gap-3 text-xs">
        <span className="text-[var(--noetic-text-muted)]">
          Depth: <span className="text-[var(--noetic-text)]">{node.depth}</span>
        </span>
        {node.durationMs && (
          <span className="text-[var(--noetic-text-muted)]">
            Duration:{' '}
            <span className="text-[var(--noetic-text)]">{formatDuration(node.durationMs)}</span>
          </span>
        )}
      </div>

      {node.error && (
        <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-red-500">Error</p>
            <p className="text-xs text-red-400 truncate">{node.error.message}</p>
          </div>
        </div>
      )}
    </div>
  );
};

interface SystemPromptProps {
  stepData: LLMStepData;
}

const SystemPrompt: React.FC<SystemPromptProps> = ({ stepData }) => {
  const systemMessage = stepData.messages.find((m) => m.role === 'system');

  if (!systemMessage) {
    return null;
  }

  return (
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
  );
};

interface AttemptDetailsProps {
  node: ReturnType<typeof useExecutionStore.getState>['selectedNode'];
}

const AttemptDetails: React.FC<AttemptDetailsProps> = ({ node }) => {
  if (!node) {
    return null;
  }

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-medium text-[var(--noetic-text)] uppercase tracking-wide">
        Execution Details
      </h4>

      <div className="grid grid-cols-2 gap-2">
        <DetailItem label="Started" value={formatTimestamp(node.startTime)} />
        <DetailItem
          label="Ended"
          value={node.endTime ? formatTimestamp(node.endTime) : 'Running...'}
        />
        <DetailItem label="Duration" value={formatDuration(node.durationMs || 0)} />
        <DetailItem label="Status" value={node.status} />
      </div>

      <div className="pt-2 border-t border-[var(--noetic-border)]">
        <h5 className="text-xs font-medium text-[var(--noetic-text-muted)] mb-2">Step Data</h5>
        <pre className="text-xs font-mono text-[var(--noetic-text)] bg-[var(--noetic-code-bg)] p-2 rounded max-h-48 overflow-auto">
          {JSON.stringify(node.stepData, null, 2)}
        </pre>
      </div>
    </div>
  );
};

interface DetailItemProps {
  label: string;
  value: string;
}

const DetailItem: React.FC<DetailItemProps> = ({ label, value }) => {
  return (
    <div className="p-2 bg-[var(--noetic-node-bg)] rounded border border-[var(--noetic-border)]">
      <p className="text-xs text-[var(--noetic-text-muted)]">{label}</p>
      <p className="text-sm text-[var(--noetic-text)] font-medium">{value}</p>
    </div>
  );
};

interface ToolResultProps {
  stepData: ToolStepData;
}

const ToolResult: React.FC<ToolResultProps> = ({ stepData }) => {
  return (
    <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-orange-500/10 border-b border-[var(--noetic-border)]">
        <Terminal className="w-3.5 h-3.5 text-orange-500" />
        <span className="text-xs font-medium text-orange-500">Tool: {stepData.toolName}</span>
      </div>
      <div className="p-3 space-y-3">
        <div>
          <p className="text-xs text-[var(--noetic-text-muted)] mb-1">Arguments</p>
          <pre className="text-xs font-mono text-[var(--noetic-text)] bg-[var(--noetic-code-bg)] p-2 rounded">
            {JSON.stringify(stepData.arguments, null, 2)}
          </pre>
        </div>
        <div>
          <p className="text-xs text-[var(--noetic-text-muted)] mb-1">Result</p>
          <pre className="text-xs font-mono text-[var(--noetic-text)] bg-[var(--noetic-code-bg)] p-2 rounded">
            {JSON.stringify(stepData.result, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
};

const formatTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};
