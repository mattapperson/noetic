import type React from 'react';
import { useState } from 'react';
import { formatBytes, prettyPrintJson, truncateString } from '../../lib/json-viewer';
import type { ExecutionNode, ExecutionTrace } from '../../types';
import { Copy, Download, FileJson, Maximize, Search } from './icons';

interface RawTraceProps {
  node: ExecutionNode;
  trace?: ExecutionTrace;
}

export const RawTrace: React.FC<RawTraceProps> = ({ node, trace }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);

  const traceData = {
    node: sanitizeForDisplay(node),
    trace: trace ? sanitizeForDisplay(trace) : undefined,
    timestamp: Date.now(),
  };

  const jsonString = prettyPrintJson(traceData, 2);
  const filteredJson = searchQuery ? highlightSearch(jsonString, searchQuery) : jsonString;

  const copyToClipboard = () => {
    navigator.clipboard.writeText(jsonString);
  };

  const downloadJson = () => {
    const blob = new Blob(
      [
        jsonString,
      ],
      {
        type: 'application/json',
      },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trace-${node.id}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className={`space-y-3 ${isFullscreen ? 'fixed inset-0 z-50 bg-[var(--noetic-bg)] p-4' : ''}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileJson className="w-4 h-4 text-[var(--noetic-text-muted)]" />
          <span className="text-xs font-medium text-[var(--noetic-text)]">OpenTelemetry Trace</span>
          <span className="text-xs text-[var(--noetic-text-muted)] bg-[var(--noetic-border)] px-2 py-0.5 rounded-full">
            {formatBytes(
              new Blob([
                jsonString,
              ]).size,
            )}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copyToClipboard}
            className="p-1.5 rounded hover:bg-[var(--noetic-hover)] transition-colors"
            title="Copy JSON"
          >
            <Copy className="w-3.5 h-3.5 text-[var(--noetic-text-secondary)]" />
          </button>
          <button
            type="button"
            onClick={downloadJson}
            className="p-1.5 rounded hover:bg-[var(--noetic-hover)] transition-colors"
            title="Download JSON"
          >
            <Download className="w-3.5 h-3.5 text-[var(--noetic-text-secondary)]" />
          </button>
          <button
            type="button"
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-1.5 rounded hover:bg-[var(--noetic-hover)] transition-colors"
            title="Toggle fullscreen"
          >
            <Maximize className="w-3.5 h-3.5 text-[var(--noetic-text-secondary)]" />
          </button>
        </div>
      </div>

      <div className="relative">
        <div className="flex items-center gap-2 px-3 py-2 bg-[var(--noetic-node-bg)] border border-[var(--noetic-border)] rounded-t-lg">
          <Search className="w-3.5 h-3.5 text-[var(--noetic-text-muted)]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search in trace data..."
            className="flex-1 bg-transparent text-xs text-[var(--noetic-text)] placeholder-[var(--noetic-text-muted)] focus:outline-none"
          />
          {searchQuery && (
            <span className="text-xs text-[var(--noetic-text-muted)]">
              {countMatches(jsonString, searchQuery)} matches
            </span>
          )}
        </div>

        <div
          className={`bg-[var(--noetic-code-bg)] border border-t-0 border-[var(--noetic-border)] rounded-b-lg overflow-auto font-mono text-xs ${
            isFullscreen ? 'h-[calc(100vh-120px)]' : 'max-h-96'
          }`}
        >
          <SyntaxHighlightedJson content={filteredJson} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs text-[var(--noetic-text-muted)]">
        <MetadataBadge label="Node ID" value={truncateString(node.id, 20)} />
        <MetadataBadge label="Step ID" value={truncateString(node.stepId, 20)} />
        <MetadataBadge label="Kind" value={node.kind} />
        <MetadataBadge label="Status" value={node.status} />
        <MetadataBadge label="Depth" value={String(node.depth)} />
      </div>
    </div>
  );
};

interface MetadataBadgeProps {
  label: string;
  value: string;
}

const MetadataBadge: React.FC<MetadataBadgeProps> = ({ label, value }) => (
  <div className="flex items-center gap-1 px-2 py-1 bg-[var(--noetic-node-bg)] border border-[var(--noetic-border)] rounded-md">
    <span className="text-[var(--noetic-text-muted)]">{label}:</span>
    <span className="text-[var(--noetic-text)] font-medium">{value}</span>
  </div>
);

interface SyntaxHighlightedJsonProps {
  content: string;
}

const SyntaxHighlightedJson: React.FC<SyntaxHighlightedJsonProps> = ({ content }) => {
  const lines = content.split('\n');

  return (
    <div className="p-4">
      {lines.map((line, index) => (
        <div key={`line-${index}-${line.slice(0, 20)}`} className="flex">
          <span className="w-8 text-right pr-3 text-[var(--noetic-text-muted)] select-none flex-shrink-0">
            {index + 1}
          </span>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is escaped before highlighting, making this safe */}
          <span
            className="flex-1 whitespace-pre"
            dangerouslySetInnerHTML={{
              __html: highlightLine(line),
            }}
          />
        </div>
      ))}
    </div>
  );
};

const highlightLine = (line: string): string => {
  // Escape HTML
  let highlighted = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Highlight strings
  highlighted = highlighted.replace(
    /"([^"\\]*(\\.[^"\\]*)*)"/g,
    '<span class="text-[var(--noetic-json-string)]">"$1"</span>',
  );

  // Highlight numbers
  highlighted = highlighted.replace(
    /\b(\d+\.?\d*)\b/g,
    '<span class="text-[var(--noetic-json-number)]">$1</span>',
  );

  // Highlight booleans and null
  highlighted = highlighted.replace(
    /\b(true|false|null)\b/g,
    '<span class="text-[var(--noetic-json-boolean)]">$1</span>',
  );

  // Highlight keys
  highlighted = highlighted.replace(
    /(<span[^>]*>"[^"]*"<\/span>)(\s*:)/g,
    '<span class="text-[var(--noetic-json-object)]">$1</span>$2',
  );

  // Highlight punctuation
  highlighted = highlighted.replace(
    /([{}[\],])/g,
    '<span class="text-[var(--noetic-text-muted)]">$1</span>',
  );

  return highlighted;
};

const highlightSearch = (content: string, query: string): string => {
  if (!query) {
    return content;
  }
  const regex = new RegExp(`(${escapeRegExp(query)})`, 'gi');
  return content.replace(regex, '>>$1<<');
};

const countMatches = (content: string, query: string): number => {
  if (!query) {
    return 0;
  }
  const regex = new RegExp(escapeRegExp(query), 'gi');
  const matches = content.match(regex);
  return matches ? matches.length : 0;
};

const escapeRegExp = (string: string): string => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// Sanitize circular references and non-serializable data for display
const sanitizeForDisplay = (obj: unknown): unknown => {
  const seen = new WeakSet<object>();

  const sanitize = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    // At this point, value is definitely an object (not null)
    const objValue = value;

    if (seen.has(objValue)) {
      return '[Circular]';
    }

    if (objValue instanceof Map) {
      seen.add(objValue);
      const result: Record<string, unknown> = {};
      for (const [k, v] of objValue.entries()) {
        result[String(k)] = sanitize(v);
      }
      return result;
    }

    if (objValue instanceof Set) {
      seen.add(objValue);
      return Array.from(objValue).map(sanitize);
    }

    if (objValue instanceof Date) {
      return objValue.toISOString();
    }

    if (objValue instanceof Error) {
      return {
        message: objValue.message,
        name: objValue.name,
        stack: objValue.stack,
      };
    }

    if (Array.isArray(objValue)) {
      seen.add(objValue);
      return objValue.map(sanitize);
    }

    // Handle plain objects
    seen.add(objValue);
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(objValue)) {
      result[k] = sanitize(v);
    }
    return result;
  };

  return sanitize(obj);
};
