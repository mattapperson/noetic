import type React from 'react';
import { useState } from 'react';
import { formatDuration } from '../../lib/format';
import type { ExecutionNode } from '../../types';
import { ChevronDown, ChevronRight, Layers } from './icons';

//#region Constants

const MAX_VISIBLE_CHILDREN = 10;

const KIND_COLORS: Record<string, string> = {
  run: 'bg-blue-500/20 text-blue-400',
  llm: 'bg-purple-500/20 text-purple-400',
  tool: 'bg-orange-500/20 text-orange-400',
  branch: 'bg-teal-500/20 text-teal-400',
  fork: 'bg-cyan-500/20 text-cyan-400',
  spawn: 'bg-pink-500/20 text-pink-400',
  loop: 'bg-yellow-500/20 text-yellow-400',
};

const STATUS_ICONS: Record<string, string> = {
  completed: '\u2713',
  running: '\u25CF',
  error: '\u2717',
  paused: '\u275A\u275A',
  pending: '\u25CB',
  cancelled: '\u2014',
};

//#endregion

//#region Helper Functions

const getStatusColor = (status: string): string => {
  const colors: Record<string, string> = {
    completed: 'text-green-500',
    running: 'text-blue-500',
    error: 'text-red-500',
    paused: 'text-yellow-500',
    pending: 'text-gray-400',
    cancelled: 'text-gray-500',
  };
  return colors[status] ?? 'text-gray-400';
};

//#endregion

//#region ChildEntry

interface ChildEntryProps {
  node: ExecutionNode;
  onSelectNode?: (nodeId: string) => void;
}

const ChildEntry: React.FC<ChildEntryProps> = ({ node, onSelectNode }) => {
  const kindColor = KIND_COLORS[node.kind] ?? 'bg-gray-500/20 text-gray-400';
  const statusIcon = STATUS_ICONS[node.status] ?? '\u25CB';
  const statusColor = getStatusColor(node.status);

  return (
    <button
      type="button"
      onClick={() => onSelectNode?.(node.id)}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--noetic-border)]/50 transition-colors text-left group"
    >
      <span className={`text-xs ${statusColor}`}>{statusIcon}</span>
      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${kindColor}`}>
        {node.kind.toUpperCase()}
      </span>
      <span className="text-xs text-[var(--noetic-text)] truncate flex-1 font-mono">
        {node.stepId}
      </span>
      {node.durationMs !== null && (
        <span className="text-xs text-[var(--noetic-text-muted)] tabular-nums shrink-0">
          {formatDuration(node.durationMs)}
        </span>
      )}
    </button>
  );
};

//#endregion

//#region ChildrenList

interface ChildrenListProps {
  childIds: string[];
  nodes: Map<string, ExecutionNode>;
  onSelectNode?: (nodeId: string) => void;
}

export const ChildrenList: React.FC<ChildrenListProps> = ({ childIds, nodes, onSelectNode }) => {
  const [expanded, setExpanded] = useState(false);

  const uniqueIds = [
    ...new Set(childIds),
  ];
  const children = uniqueIds
    .map((id) => nodes.get(id))
    .filter((n): n is ExecutionNode => n !== undefined);

  if (children.length === 0) {
    return null;
  }

  const visibleChildren = expanded ? children : children.slice(0, MAX_VISIBLE_CHILDREN);
  const hasMore = children.length > MAX_VISIBLE_CHILDREN;

  return (
    <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-[var(--noetic-node-bg)] border-b border-[var(--noetic-border)]">
        <Layers className="w-3.5 h-3.5 text-[var(--noetic-accent)]" />
        <span className="text-xs font-medium text-[var(--noetic-text)]">
          Children ({children.length})
        </span>
      </div>
      <div className="p-2 space-y-0.5">
        {visibleChildren.map((child) => (
          <ChildEntry key={child.id} node={child} onSelectNode={onSelectNode} />
        ))}
        {hasMore && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="w-full text-center py-1.5 text-xs text-[var(--noetic-accent)] hover:underline transition-colors"
          >
            {expanded ? 'Show less' : `Show all ${children.length}`}
          </button>
        )}
      </div>
    </div>
  );
};

//#endregion

//#region GroupedChildrenList

interface GroupedChildrenListProps {
  childIds: string[];
  nodes: Map<string, ExecutionNode>;
  totalIterations: number;
  onSelectNode?: (nodeId: string) => void;
}

interface IterationGroup {
  iteration: number;
  children: ExecutionNode[];
}

export const buildIterationGroups = (
  children: ExecutionNode[],
  totalIterations: number,
): IterationGroup[] => {
  if (totalIterations <= 0 || children.length === 0) {
    return [];
  }

  const groupSize = Math.floor(children.length / totalIterations);
  if (groupSize === 0) {
    return [
      {
        iteration: 1,
        children,
      },
    ];
  }

  const groups: IterationGroup[] = [];
  for (let i = 0; i < totalIterations; i++) {
    const start = i * groupSize;
    const isLast = i === totalIterations - 1;
    const end = isLast ? children.length : start + groupSize;
    groups.push({
      iteration: i + 1,
      children: children.slice(start, end),
    });
  }

  return groups;
};

const getAggregateStatus = (children: ExecutionNode[]): string => {
  if (children.some((c) => c.status === 'error')) {
    return 'error';
  }
  if (children.some((c) => c.status === 'running')) {
    return 'running';
  }
  if (children.every((c) => c.status === 'completed')) {
    return 'completed';
  }
  if (children.some((c) => c.status === 'paused')) {
    return 'paused';
  }
  return 'pending';
};

const getAggregateDuration = (children: ExecutionNode[]): number => {
  return children.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
};

const IterationHeader: React.FC<{
  group: IterationGroup;
  isOpen: boolean;
  onToggle: () => void;
}> = ({ group, isOpen, onToggle }) => {
  const status = getAggregateStatus(group.children);
  const duration = getAggregateDuration(group.children);
  const statusIcon = STATUS_ICONS[status] ?? '\u25CB';
  const statusColor = getStatusColor(status);

  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--noetic-border)]/50 transition-colors text-left"
    >
      {isOpen ? (
        <ChevronDown className="w-3 h-3 text-[var(--noetic-text-muted)]" />
      ) : (
        <ChevronRight className="w-3 h-3 text-[var(--noetic-text-muted)]" />
      )}
      <span className="text-xs font-medium text-[var(--noetic-text)]">
        Iteration {group.iteration}
      </span>
      <span className={`text-xs ${statusColor}`}>{statusIcon}</span>
      {duration > 0 && (
        <span className="text-xs text-[var(--noetic-text-muted)] tabular-nums ml-auto">
          {formatDuration(duration)}
        </span>
      )}
    </button>
  );
};

export const GroupedChildrenList: React.FC<GroupedChildrenListProps> = ({
  childIds,
  nodes,
  totalIterations,
  onSelectNode,
}) => {
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set());

  const uniqueIds = [
    ...new Set(childIds),
  ];
  const children = uniqueIds
    .map((id) => nodes.get(id))
    .filter((n): n is ExecutionNode => n !== undefined);

  const groups = buildIterationGroups(children, totalIterations);

  if (groups.length === 0) {
    return null;
  }

  const toggleGroup = (iteration: number): void => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(iteration)) {
        next.delete(iteration);
      } else {
        next.add(iteration);
      }
      return next;
    });
  };

  return (
    <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-[var(--noetic-node-bg)] border-b border-[var(--noetic-border)]">
        <Layers className="w-3.5 h-3.5 text-[var(--noetic-accent)]" />
        <span className="text-xs font-medium text-[var(--noetic-text)]">
          Iterations ({groups.length})
        </span>
      </div>
      <div className="p-2 space-y-0.5">
        {groups.map((group) => {
          const isOpen = openGroups.has(group.iteration);
          return (
            <div key={group.iteration}>
              <IterationHeader
                group={group}
                isOpen={isOpen}
                onToggle={() => toggleGroup(group.iteration)}
              />
              {isOpen && (
                <div className="ml-4 space-y-0.5">
                  {group.children.map((child) => (
                    <ChildEntry key={child.id} node={child} onSelectNode={onSelectNode} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

//#endregion
