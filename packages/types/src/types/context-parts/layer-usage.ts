import type { Item } from '../items';

/** @public Per-layer contribution to the context window on the most recent LLM call. */
export interface LayerUsageEntry {
  readonly layerId: string;
  readonly tokenCount: number;
  /** Items this layer contributed to the context view for the last LLM call. */
  readonly items: ReadonlyArray<Item>;
}

/** @public Breakdown of the context window as of the most recent LLM call in an execution. */
export interface LastLayerUsage {
  readonly executionId: string;
  readonly modelId: string;
  readonly layers: ReadonlyArray<LayerUsageEntry>;
  readonly systemPromptTokens: number;
  readonly toolsTokens: number;
  readonly historyTokens: number;
  readonly totalUsedTokens: number;
}
