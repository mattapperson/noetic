import type React from 'react';
import type { ExecutionNode } from '../../../types';

//#region Types

export interface SummaryRendererProps {
  node: ExecutionNode;
  nodes: Map<string, ExecutionNode>;
  onSelectNode?: (nodeId: string) => void;
}

export type SummaryRenderer = React.FC<SummaryRendererProps>;

//#endregion

//#region Registry

const renderers = new Map<string, SummaryRenderer>();

export function registerSummaryRenderer(kind: string, renderer: SummaryRenderer): void {
  renderers.set(kind, renderer);
}

export function getSummaryRenderer(kind: string): SummaryRenderer {
  return renderers.get(kind) ?? renderers.get('default') ?? FallbackSummary;
}

/** Inline fallback in case the registry is fully cleared (testing). */
const FallbackSummary: SummaryRenderer = ({ node }) => {
  const entries = Object.entries(node.stepData);
  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="border border-[var(--noetic-border)] rounded-lg p-3 bg-[var(--noetic-node-bg)]">
      <pre className="text-xs font-mono text-[var(--noetic-text)] whitespace-pre-wrap break-words">
        {JSON.stringify(node.stepData, null, 2)}
      </pre>
    </div>
  );
};

export function unregisterSummaryRenderer(kind: string): void {
  renderers.delete(kind);
}

export function clearSummaryRenderers(): void {
  renderers.clear();
}

//#endregion

//#region Built-in Registration

/**
 * Register built-in summary renderers. Called automatically on first import,
 * and can be called again to restore built-ins after clearSummaryRenderers().
 */
export function registerBuiltInSummaries(): void {
  // Dynamic requires avoid the ESM circular-import TDZ that occurs when
  // static `import './DefaultSummary'` etc. are hoisted above `const renderers`.
  /* eslint-disable @typescript-eslint/no-require-imports */
  require('./DefaultSummary');
  require('./BranchSummary');
  require('./ForkSummary');
  require('./LoopSummary');
  require('./SpawnSummary');
  require('./LLMSummary');
  require('./ToolSummary');
  /* eslint-enable @typescript-eslint/no-require-imports */
}

registerBuiltInSummaries();

//#endregion
