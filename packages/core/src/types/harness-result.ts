import type { LastLayerUsage } from './context';
import type { Item } from './items';

//#region Stream Event Types

/** @public SDK-originated event from the OpenResponses streaming API. */
export interface SdkStreamEvent {
  readonly source: 'sdk';
  /** OpenResponses SSE event type string (e.g., 'response.output_text.delta'). */
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly outputIndex?: number;
  readonly contentIndex?: number;
}

/** @public Framework-originated event, prefixed with the harness config.name. */
export interface FrameworkStreamEvent {
  readonly source: 'framework';
  /** Prefixed event type (e.g., 'myagent:step_started'). */
  readonly type: `${string}:${string}`;
  readonly data: Record<string, unknown>;
}

/** @public Union of all stream event types emitted during execution. */
export type StreamEvent = SdkStreamEvent | FrameworkStreamEvent;

//#endregion

//#region Harness Response

/** @public Final accumulated result of an execution, including all items, usage, cost, and extracted text. */
export interface HarnessResponse {
  readonly items: ReadonlyArray<Item>;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedTokens?: number;
  };
  readonly cost?: number;
  readonly text: string;
  /** Per-memory-layer context window breakdown captured at the last callModel of this execution. */
  readonly lastLayerUsage?: LastLayerUsage;
}

//#endregion

//#region Streaming Item

/** @public An Item snapshot with a completion flag, emitted from getItemStream(). */
export type StreamingItem = Item & {
  readonly isComplete: boolean;
};

//#endregion

//#region Harness Result

/** @public Result object returned by execute(), providing multiple stream accessors for consuming execution output. */
export interface HarnessResult {
  /** Resolves with the final text output after execution completes. */
  getText(): Promise<string>;
  /** Resolves with the full response including items, usage, and cost. */
  getResponse(): Promise<HarnessResponse>;
  /** Yields text deltas as they arrive from the model. */
  getTextStream(): AsyncIterable<string>;
  /** Yields reasoning token deltas from reasoning-capable models. */
  getReasoningStream(): AsyncIterable<string>;
  /** Yields cumulative Item snapshots with isComplete flag. Replace, do not append. */
  getItemStream(): AsyncIterable<StreamingItem>;
  /** Yields all raw stream events (SDK + framework). */
  getFullStream(): AsyncIterable<StreamEvent>;
}

//#endregion
