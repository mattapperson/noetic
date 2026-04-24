import type React from 'react';
import { useState } from 'react';
import { formatBytes, prettyPrintJson } from '../../lib/json-viewer';
import type { ContextSnapshot } from '../../types';
import { ChevronDown, ChevronRight, Clock, Coins, Database, Layers } from './icons';

interface ContextStateProps {
  snapshot: ContextSnapshot;
  showMemory?: boolean;
}

export const ContextState: React.FC<ContextStateProps> = ({ snapshot, showMemory = true }) => {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set([
      'context',
      'tokens',
      'state',
    ]),
  );

  const toggleSection = (section: string) => {
    const newSet = new Set(expandedSections);
    if (newSet.has(section)) {
      newSet.delete(section);
    } else {
      newSet.add(section);
    }
    setExpandedSections(newSet);
  };

  const isExpanded = (section: string) => expandedSections.has(section);

  return (
    <div className="space-y-2">
      <MetricRow
        icon={<Database className="w-3.5 h-3.5" />}
        label="Depth"
        value={`${snapshot.depth} levels`}
        color="text-purple-500"
      />
      <MetricRow
        icon={<Clock className="w-3.5 h-3.5" />}
        label="Step Count"
        value={String(snapshot.stepCount)}
        color="text-blue-500"
      />
      <MetricRow
        icon={<Layers className="w-3.5 h-3.5" />}
        label="Item Log"
        value={`${snapshot.itemLogLength} items`}
        color="text-teal-500"
      />

      <CollapsibleSection
        title="Token Usage"
        isExpanded={isExpanded('tokens')}
        onToggle={() => toggleSection('tokens')}
      >
        <div className="space-y-1">
          <TokenBar
            label="Input"
            value={snapshot.tokens.input}
            total={snapshot.tokens.total}
            color="bg-blue-500"
          />
          <TokenBar
            label="Output"
            value={snapshot.tokens.output}
            total={snapshot.tokens.total}
            color="bg-green-500"
          />
          <div className="pt-1 border-t border-[var(--noetic-border)]">
            <div className="flex justify-between text-xs">
              <span className="text-[var(--noetic-text-muted)]">Total</span>
              <span className="font-medium text-[var(--noetic-text)]">
                {snapshot.tokens.total.toLocaleString()} tokens
              </span>
            </div>
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Cost"
        isExpanded={isExpanded('cost')}
        onToggle={() => toggleSection('cost')}
      >
        <div className="flex items-center gap-2">
          <Coins className="w-4 h-4 text-yellow-500" />
          <span className="text-sm font-medium text-[var(--noetic-text)]">
            ${snapshot.cost.toFixed(4)}
          </span>
        </div>
      </CollapsibleSection>

      {showMemory && (
        <CollapsibleSection
          title="State"
          isExpanded={isExpanded('state')}
          onToggle={() => toggleSection('state')}
        >
          <div className="relative">
            <pre className="text-xs font-mono text-[var(--noetic-text)] whitespace-pre-wrap break-all max-h-40 overflow-auto p-2 bg-[var(--noetic-code-bg)] rounded">
              {prettyPrintJson(snapshot.state, 2)}
            </pre>
            <div className="absolute bottom-2 right-2 text-xs text-[var(--noetic-text-muted)] bg-[var(--noetic-node-bg)] px-2 py-1 rounded border border-[var(--noetic-border)]">
              {formatBytes(
                new Blob([
                  JSON.stringify(snapshot.state),
                ]).size,
              )}
            </div>
          </div>
        </CollapsibleSection>
      )}

      <MetricRow
        icon={<Clock className="w-3.5 h-3.5" />}
        label="Elapsed"
        value={formatDuration(snapshot.elapsedMs)}
        color="text-orange-500"
      />
    </div>
  );
};

interface MetricRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
}

const MetricRow: React.FC<MetricRowProps> = ({ icon, label, value, color }) => {
  return (
    <div className="flex items-center justify-between py-1.5 px-2 rounded-md bg-[var(--noetic-node-bg)] hover:bg-[var(--noetic-hover)] transition-colors">
      <div className="flex items-center gap-2">
        <span className={color}>{icon}</span>
        <span className="text-xs text-[var(--noetic-text-secondary)]">{label}</span>
      </div>
      <span className="text-xs font-medium text-[var(--noetic-text)]">{value}</span>
    </div>
  );
};

interface TokenBarProps {
  label: string;
  value: number;
  total: number;
  color: string;
}

const TokenBar: React.FC<TokenBarProps> = ({ label, value, total, color }) => {
  const percentage = total > 0 ? (value / total) * 100 : 0;

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-[var(--noetic-text-muted)]">{label}</span>
        <span className="text-[var(--noetic-text)]">{value.toLocaleString()}</span>
      </div>
      <div className="h-1.5 bg-[var(--noetic-border)] rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full`}
          style={{
            width: `${percentage}%`,
          }}
        />
      </div>
    </div>
  );
};

interface CollapsibleSectionProps {
  title: string;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  isExpanded,
  onToggle,
  children,
}) => {
  return (
    <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-[var(--noetic-text)] hover:bg-[var(--noetic-hover)] transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-[var(--noetic-text-muted)]" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-[var(--noetic-text-muted)]" />
        )}
        {title}
      </button>
      {isExpanded && (
        <div className="px-3 pb-3 border-t border-[var(--noetic-border)] pt-2">{children}</div>
      )}
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
