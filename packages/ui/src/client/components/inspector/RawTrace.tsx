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

interface HighlightedSegment {
  text: string;
  className?: string;
}

/**
 * Parse a line into highlighted segments for safe React rendering
 * Avoids dangerouslySetInnerHTML by building segment arrays
 */
const parseLineToSegments = (line: string): HighlightedSegment[] => {
  const segments: HighlightedSegment[] = [];
  let remaining = line;

  // Helper to add segment
  const addSegment = (text: string, className?: string) => {
    segments.push({
      text,
      className,
    });
  };

  // Helper to consume matched text
  const consume = (pattern: RegExp, className: string | undefined): boolean => {
    const match = remaining.match(pattern);
    if (match && match.index === 0) {
      addSegment(match[0], className);
      remaining = remaining.slice(match[0].length);
      return true;
    }
    return false;
  };

  while (remaining.length > 0) {
    let consumed = false;

    // Try patterns in order of specificity
    consumed = consumed || consume(/^"(?:[^"\\]|\\.)*"/, 'text-[var(--noetic-json-string)]');
    consumed = consumed || consume(/^\b(?:true|false|null)\b/, 'text-[var(--noetic-json-boolean)]');
    consumed = consumed || consume(/^\b\d+(?:\.\d+)?\b/, 'text-[var(--noetic-json-number)]');
    consumed = consumed || consume(/^[{}[\],]/, 'text-[var(--noetic-text-muted)]');
    consumed = consumed || consume(/^\s+/, undefined); // Whitespace, no special styling
    consumed = consumed || consume(/^./, 'text-[var(--noetic-json-object)]'); // Any other char

    if (!consumed) {
      // Safety valve: consume one character to avoid infinite loop
      addSegment(remaining[0], undefined);
      remaining = remaining.slice(1);
    }
  }

  return segments;
};

const SyntaxHighlightedJson: React.FC<SyntaxHighlightedJsonProps> = ({ content }) => {
  const lines = content.split('\n');

  return (
    <div className="p-4">
      {lines.map((line, lineIdx) => {
        const lineKey = `L${lineIdx}-${line.length}`;
        return (
          <div key={lineKey} className="flex">
            <span className="w-8 text-right pr-3 text-[var(--noetic-text-muted)] select-none flex-shrink-0">
              {lineIdx + 1}
            </span>
            <span className="flex-1 whitespace-pre">
              {parseLineToSegments(line).map((segment, segIdx) => {
                const segKey = `${lineKey}-S${segIdx}-${segment.text.length}`;
                return (
                  <span key={segKey} className={segment.className}>
                    {segment.text}
                  </span>
                );
              })}
            </span>
          </div>
        );
      })}
    </div>
  );
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

  const sanitize = (value: unknown, key?: string): unknown => {
    // Parse JSON-encoded strings in input/output/state fields so the raw
    // trace view shows structured data instead of escaped string literals
    if (typeof value === 'string' && (key === 'input' || key === 'output' || key === 'state')) {
      const trimmed = value.trim();
      if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        try {
          return sanitize(JSON.parse(trimmed));
        } catch {
          // Not valid JSON, return as string
        }
      }
    }

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
        result[String(k)] = sanitize(v, String(k));
      }
      return result;
    }

    if (objValue instanceof Set) {
      seen.add(objValue);
      return Array.from(objValue).map((item) => sanitize(item));
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
      return objValue.map((item) => sanitize(item));
    }

    // Handle plain objects
    seen.add(objValue);
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(objValue)) {
      result[k] = sanitize(v, k);
    }
    return result;
  };

  return sanitize(obj);
};
