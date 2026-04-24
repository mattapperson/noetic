import type React from 'react';
import { useState } from 'react';
import { ChevronDown, ChevronRight } from '../icons';
import type { SummaryRendererProps } from './registry';
import { registerSummaryRenderer } from './registry';

//#region CollapsibleValue

interface CollapsibleValueProps {
  label: string;
  value: unknown;
}

const CollapsibleValue: React.FC<CollapsibleValueProps> = ({ label, value }) => {
  const [expanded, setExpanded] = useState(false);
  const isComplex = typeof value === 'object' && value !== null;

  if (!isComplex) {
    return (
      <div className="flex items-baseline gap-2 py-1">
        <span className="text-xs text-[var(--noetic-text-muted)] shrink-0">{label}:</span>
        <span className="text-xs font-mono text-[var(--noetic-text)] truncate">
          {String(value)}
        </span>
      </div>
    );
  }

  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-left hover:opacity-80 transition-opacity"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-[var(--noetic-text-muted)]" />
        ) : (
          <ChevronRight className="w-3 h-3 text-[var(--noetic-text-muted)]" />
        )}
        <span className="text-xs text-[var(--noetic-text-muted)]">{label}</span>
        <span className="text-xs text-[var(--noetic-text-muted)] font-mono">
          {Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`}
        </span>
      </button>
      {expanded && (
        <pre className="mt-1 ml-4 text-xs font-mono text-[var(--noetic-text)] bg-[var(--noetic-code-bg)] p-2 rounded max-h-48 overflow-auto whitespace-pre-wrap break-words">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
};

//#endregion

//#region DefaultSummary

export const DefaultSummary: React.FC<SummaryRendererProps> = ({ node }) => {
  const data = node.stepData;
  const entries = Object.entries(data);

  if (entries.length === 0) {
    return (
      <div className="border border-[var(--noetic-border)] rounded-lg p-3 bg-[var(--noetic-node-bg)]">
        <p className="text-xs text-[var(--noetic-text-muted)]">No step data available</p>
      </div>
    );
  }

  return (
    <div className="border border-[var(--noetic-border)] rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-[var(--noetic-node-bg)] border-b border-[var(--noetic-border)]">
        <span className="text-xs font-medium text-[var(--noetic-text)]">Step Details</span>
      </div>
      <div className="p-3 space-y-0.5">
        {entries.map(([key, value]) => (
          <CollapsibleValue key={key} label={key} value={value} />
        ))}
      </div>
    </div>
  );
};

//#endregion

registerSummaryRenderer('default', DefaultSummary);
