/**
 * DTOs crossing the inspector's HTTP/SSE boundary.
 *
 * The Next UI imports from this file with type-only imports, so the browser
 * bundle never touches core code — only its erased types.
 */

import type {
  BudgetConfig,
  HarnessStatus,
  Item,
  LastLayerUsage,
  StreamingItem,
} from '@noetic-tools/core';

export type { HarnessStatus, Item, LastLayerUsage, StreamingItem };

//#region Layers

/** One memory layer in the harness roster, as listed by `GET /layers`. */
export interface LayerInfo {
  id: string;
  name?: string;
  slot: number;
  scope: string;
  budget?: BudgetConfig;
}

/** Result of `GET /layers/:id/state`. `source` says where the state came from:
 *  the live in-process store, or the durable storage fallback used before the
 *  first turn of a fresh child. */
export interface LayerStateResult {
  layerId: string;
  executionId?: string;
  source: 'live' | 'storage' | 'none';
  state: unknown;
}

//#endregion

//#region SSE frames

/** A framework lifecycle event forwarded from `harness.getFullStream()`. */
export interface ForwardedEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Frames published on the agent child's `GET /stream`. */
export type AgentFrame =
  | {
      type: 'item';
      item: StreamingItem;
    }
  | {
      type: 'event';
      event: ForwardedEvent;
    }
  | {
      type: 'layer_state';
      layerId: string;
      executionId: string;
      at: number;
    }
  | {
      type: 'layer_usage';
      usage: LastLayerUsage;
    }
  | {
      type: 'preview_invalidated';
    };

/** Child lifecycle states as reported by the host. */
export type ChildState = 'starting' | 'ready' | 'restarting' | 'error';

/** One captured line of agent-process output. The host owns the buffer, so
 *  lines survive child crashes and restarts; `info` lines are host-authored
 *  markers (reloads, resets, exits). */
export interface ConsoleLine {
  seq: number;
  stream: 'stdout' | 'stderr' | 'info';
  text: string;
  at: number;
}

/** Frames published on the host's `GET /api/host/events`. */
export type HostFrame =
  | HostEvent
  | {
      type: 'console_line';
      line: ConsoleLine;
    };

/** Frames published on the host's `GET /api/host/events` (also the shape of
 *  `GET /api/host/status`). */
export interface HostEvent {
  type: 'child_status';
  child: ChildState;
  revision: number;
  error?: {
    message: string;
    stderrTail: string;
  };
}

//#endregion

//#region Requests / responses

export interface ChatRequest {
  text: string;
  messageId?: string;
  deliveryMode?: 'next-turn' | 'between-rounds' | 'next-item' | 'interrupt';
}

export interface CodeResponse {
  source: string;
  path: string;
  revision: number;
}

/** A span serialized for `GET /trace` (SpanImpl's Map attributes flattened). */
export interface WireSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  events: Array<{
    name: string;
    attributes?: Record<string, unknown>;
  }>;
}

//#endregion
