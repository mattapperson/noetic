import type React from 'react';
import { useState } from 'react';
import type { FormattedNode } from '../../lib/json-viewer';
import { formatJsonValue, formatValue } from '../../lib/json-viewer';
import { ChevronDown, ChevronRight } from './icons';

interface InputOutputProps {
  input: unknown;
  output: unknown | null;
  title?: string;
}

export const InputOutput: React.FC<InputOutputProps> = ({ input, output, title }) => {
  const [inputExpanded, setInputExpanded] = useState(true);
  const [outputExpanded, setOutputExpanded] = useState(true);

  const inputNode = formatJsonValue(input, 'input');
  const outputNode = output !== null ? formatJsonValue(output, 'output') : null;

  return (
    <div className="space-y-3">
      {title && (
        <h4 className="text-xs font-medium text-[var(--noetic-text)] uppercase tracking-wide">
          {title}
        </h4>
      )}

      <CollapsibleSection
        title="Input"
        isExpanded={inputExpanded}
        onToggle={() => setInputExpanded(!inputExpanded)}
      >
        <JsonTree node={inputNode} />
      </CollapsibleSection>

      <CollapsibleSection
        title="Output"
        isExpanded={outputExpanded}
        onToggle={() => setOutputExpanded(!outputExpanded)}
        isEmpty={output === null}
      >
        {outputNode ? <JsonTree node={outputNode} /> : <EmptyState message="No output yet" />}
      </CollapsibleSection>
    </div>
  );
};

interface CollapsibleSectionProps {
  title: string;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  isEmpty?: boolean;
}

const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  isExpanded,
  onToggle,
  children,
  isEmpty = false,
}) => {
  return (
    <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden bg-[var(--noetic-node-bg)]">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-[var(--noetic-text)] hover:bg-[var(--noetic-hover)] transition-colors"
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-[var(--noetic-text-muted)]" />
          ) : (
            <ChevronRight className="w-4 h-4 text-[var(--noetic-text-muted)]" />
          )}
          <span>{title}</span>
        </div>
        {isEmpty && (
          <span className="text-xs text-[var(--noetic-text-muted)] px-2 py-0.5 rounded-full bg-[var(--noetic-border)]">
            Empty
          </span>
        )}
      </button>
      {isExpanded && <div className="p-3 border-t border-[var(--noetic-border)]">{children}</div>}
    </div>
  );
};

interface JsonTreeProps {
  node: FormattedNode;
  defaultExpandedDepth?: number;
}

const JsonTree: React.FC<JsonTreeProps> = ({ node, defaultExpandedDepth = 1 }) => {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => {
    const keys = new Set<string>();
    if (node.children) {
      for (const child of node.children) {
        if (child.depth <= defaultExpandedDepth && child.isExpandable) {
          keys.add(getNodeKey(child));
        }
      }
    }
    return keys;
  });

  const toggleKey = (key: string) => {
    const newKeys = new Set(expandedKeys);
    if (newKeys.has(key)) {
      newKeys.delete(key);
    } else {
      newKeys.add(key);
    }
    setExpandedKeys(newKeys);
  };

  return (
    <div className="font-mono text-xs">
      <JsonNode node={node} expandedKeys={expandedKeys} onToggle={toggleKey} isRoot />
    </div>
  );
};

interface JsonNodeProps {
  node: FormattedNode;
  expandedKeys: Set<string>;
  onToggle: (key: string) => void;
  isRoot?: boolean;
}

const JsonNode: React.FC<JsonNodeProps> = ({ node, expandedKeys, onToggle, isRoot = false }) => {
  const nodeKey = getNodeKey(node);
  const isExpanded = expandedKeys.has(nodeKey);

  if (!node.isExpandable) {
    return (
      <div className="py-0.5">
        {!isRoot && <span className="text-[var(--noetic-text-muted)] mr-2">{node.key}:</span>}
        <span className={getTypeColorClass(node.type)}>{formatValue(node.value, node.type)}</span>
      </div>
    );
  }

  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => onToggle(nodeKey)}
        className="flex items-start gap-1 text-left hover:opacity-80 transition-opacity"
      >
        {isExpanded ? (
          <ChevronDown className="w-3 h-3 mt-0.5 text-[var(--noetic-text-muted)]" />
        ) : (
          <ChevronRight className="w-3 h-3 mt-0.5 text-[var(--noetic-text-muted)]" />
        )}
        {!isRoot && <span className="text-[var(--noetic-text-muted)]">{node.key}:</span>}
        <span className={getTypeColorClass(node.type)}>{formatValue(node.value, node.type)}</span>
      </button>

      {isExpanded && node.children && (
        <div className="pl-4 border-l border-[var(--noetic-border)] ml-1.5">
          {node.children.map((child) => (
            <JsonNode
              key={getNodeKey(child)}
              node={child}
              expandedKeys={expandedKeys}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const getNodeKey = (node: FormattedNode): string => {
  return `${node.key}-${node.depth}-${JSON.stringify(node.value).slice(0, 20)}`;
};

const getTypeColorClass = (type: FormattedNode['type']): string => {
  switch (type) {
    case 'string': {
      return 'text-[var(--noetic-json-string)]';
    }
    case 'number': {
      return 'text-[var(--noetic-json-number)]';
    }
    case 'boolean': {
      return 'text-[var(--noetic-json-boolean)]';
    }
    case 'null': {
      return 'text-[var(--noetic-json-null)]';
    }
    case 'array': {
      return 'text-[var(--noetic-json-array)]';
    }
    case 'object': {
      return 'text-[var(--noetic-json-object)]';
    }
    default: {
      return 'text-[var(--noetic-text)]';
    }
  }
};

const EmptyState: React.FC<{
  message: string;
}> = ({ message }) => {
  return (
    <div className="py-4 text-center">
      <p className="text-sm text-[var(--noetic-text-muted)]">{message}</p>
    </div>
  );
};
