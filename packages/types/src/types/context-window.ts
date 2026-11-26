import type { AcpContentBlock } from './acp';
import type { ContextLayer } from './context-layer';
import type { Item } from './items';

/** @public A context layer's contribution and freshness as seen by the harness. */
export interface LayerWindow {
  readonly layerId: string;
  readonly name: string;
  readonly recallMode: 'atomic' | 'eventual';
  readonly lastUpdatedAt: number | null;
  readonly pendingUpdate: boolean;
  readonly items: ReadonlyArray<Item>;
  readonly source?: 'fresh' | 'cache';
  readonly outcome?: 'items' | 'empty' | 'no-result' | 'disabled' | 'unpeekable' | 'failed';
}

/** @public Positions in a model request contributed by context layers. */
export interface ContextInputOrigin {
  readonly index?: number;
  readonly layerIds: ReadonlyArray<string>;
  readonly placement: 'items' | 'instructions' | 'delta';
}

/** @public Input at the boundary controlled by Noetic. */
export type ContextRequest =
  | {
      readonly target: 'model' | 'override';
      readonly model: string;
      readonly instructions?: string;
      readonly input: ReadonlyArray<unknown>;
      readonly round: number;
      readonly attempt?: number;
      readonly origins?: ReadonlyArray<ContextInputOrigin>;
      readonly sample?: number;
    }
  | {
      readonly target: 'decide' | 'decide-override';
      readonly model: string;
      readonly instructions?: string;
      readonly state: Readonly<Record<string, unknown>> | ReadonlyArray<unknown> | string;
    }
  | {
      readonly target: 'acp';
      readonly content: ReadonlyArray<AcpContentBlock>;
      readonly layerText: Readonly<Record<string, string>>;
    };

/** @public One observed or previewed context window. */
export interface ContextWindow {
  readonly threadId: string;
  readonly executionId?: string;
  readonly parentExecutionId?: string;
  readonly stepId?: string;
  readonly assemblyId?: string;
  readonly status: 'partial' | 'request' | 'preview' | 'ended';
  readonly layers: ReadonlyArray<LayerWindow>;
  readonly request?: ContextRequest;
  /** The observed payload could not be copied for readers. */
  readonly contentUnavailable?: true;
  readonly items?: ReadonlyArray<Item>;
}

/** @public A snapshot from the context stream. A gap marks updates skipped for a slow reader. */
export interface ContextStreamEvent {
  readonly sequence: number;
  readonly type: 'snapshot' | 'layer' | 'request' | 'ended';
  readonly window: ContextWindow;
  readonly layerId?: string;
  readonly pass?: 'recall' | 'rerender';
  readonly gap?: true;
}

/** @internal Result of one lifecycle observation, before final projection. */
export interface LayerRecallEvent {
  readonly layer: ContextLayer;
  readonly source: 'fresh' | 'cache';
  readonly outcome: NonNullable<LayerWindow['outcome']> | 'running';
  readonly items?: ReadonlyArray<Item>;
  readonly at?: number;
  readonly pendingUpdate?: boolean;
}

/** @internal The recording handle for one model-bound assembly. */
export interface ContextObservation {
  layer(event: LayerRecallEvent, pass?: 'recall' | 'rerender'): void;
  request(request: ContextRequest): void;
  end(): void;
}
