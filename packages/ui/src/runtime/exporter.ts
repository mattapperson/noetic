/**
 * @noetic/ui Trace Exporter
 *
 * Implements the TraceExporter interface to forward trace spans
 * to the Noetic UI WebSocket server for real-time visualization.
 *
 * The core interpreter exports spans one at a time, depth-first
 * (innermost step completes first). This exporter accumulates all
 * spans per trace and only sends trace.complete when the root span
 * (no parentSpanId) has been received and ended.
 */

import type { Span, TraceExporter } from '@noetic/core';
import WebSocket from 'ws';
import { getStepDataExtractor } from './step-extractors';
import type { ClientMessage, ExporterOptions, SerializableSpan, ServerMessage } from './types';

/** Default exporter options */
const DEFAULT_OPTIONS: Required<ExporterOptions> = {
  port: 3333,
  host: 'localhost',
  bufferSize: 100,
  flushIntervalMs: 100,
  autoReconnect: true,
  agentName: 'unnamed-agent',
};

//#region Types

interface TraceInfo {
  startTime: number;
  /** All span IDs seen for this trace (prevents duplicate nodeStart messages) */
  spanIds: Set<string>;
  /** All spans accumulated for this trace (used for depth calculation) */
  allSpans: SerializableSpan[];
  /** Whether trace.start has been sent to the server */
  started: boolean;
}

//#endregion

//#region NoeticUITraceExporter

export class NoeticUITraceExporter implements TraceExporter {
  private options: Required<ExporterOptions>;
  private ws: WebSocket | null = null;
  private spanBuffer: SerializableSpan[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private isConnecting = false;
  private messageQueue: (ClientMessage | ServerMessage)[] = [];
  private activeTraces = new Map<string, TraceInfo>();

  constructor(options: ExporterOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
    this.connect();
    this.startFlushTimer();
  }

  /**
   * Export spans to the UI server
   * Implements TraceExporter interface
   */
  async export(spans: Span[]): Promise<void> {
    const serializableSpans = spans.map((span) => this.serializeSpan(span));
    this.spanBuffer.push(...serializableSpans);

    if (this.spanBuffer.length > this.options.bufferSize) {
      this.spanBuffer = this.spanBuffer.slice(-this.options.bufferSize);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      await this.flush();
    }
  }

  /**
   * Explicitly start a trace.
   * Called once at the beginning of agent execution.
   * This ensures trace.start is sent before any spans are exported.
   */
  startTrace(traceId: string, input: unknown): void {
    // Get or create trace info
    const traceInfo = this.activeTraces.get(traceId) ?? {
      startTime: Date.now(),
      spanIds: new Set<string>(),
      allSpans: [],
      started: false,
    };

    // Only send trace.start if not already started
    if (!traceInfo.started) {
      traceInfo.started = true;
      this.activeTraces.set(traceId, traceInfo);

      // Send trace.start immediately if connected, or queue for later
      const message: ClientMessage = {
        type: 'trace.start',
        traceId,
        agentId: this.options.agentName,
        input,
        startTime: traceInfo.startTime,
      };

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(message));
      } else {
        this.messageQueue.push(message);
      }
    }
  }

  /**
   * Send an execution event to the UI server
   * Used by the debug harness for real-time updates
   */
  sendEvent(message: ClientMessage | ServerMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.messageQueue.push(message);
      if (this.messageQueue.length > this.options.bufferSize) {
        this.messageQueue = this.messageQueue.slice(-this.options.bufferSize);
      }
    }
  }

  close(): void {
    this.stopFlushTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.spanBuffer = [];
    this.messageQueue = [];
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getBufferedSpanCount(): number {
    return this.spanBuffer.length;
  }

  //#endregion

  //#region Connection Management

  private connect(): void {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.isConnecting = true;

    try {
      const url = `ws://${this.options.host}:${this.options.port}`;
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;

        if (this.options.agentName) {
          this.sendEvent({
            type: 'agent.register',
            agentId: this.options.agentName,
            agentName: this.options.agentName,
            timestamp: Date.now(),
          });
        }

        this.flushMessageQueue();
        void this.flush();
      });

      this.ws.on('close', () => {
        this.isConnecting = false;
        this.handleDisconnect();
      });

      this.ws.on('error', (error: Error) => {
        this.isConnecting = false;
        console.debug('[Noetic UI] WebSocket error:', error.message);
      });
    } catch (error) {
      this.isConnecting = false;
      console.error('[Noetic UI] Failed to connect to WebSocket server:', error);
      this.handleDisconnect();
    }
  }

  private handleDisconnect(): void {
    if (!this.options.autoReconnect) {
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * 2 ** (this.reconnectAttempts - 1), 3e4);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  //#endregion

  //#region Flush and Trace Processing

  private async flush(): Promise<void> {
    if (this.spanBuffer.length === 0 || this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    const spans = [
      ...this.spanBuffer,
    ];
    this.spanBuffer = [];

    // Group spans by traceId
    const spansByTrace = new Map<string, SerializableSpan[]>();
    for (const span of spans) {
      const traceSpans = spansByTrace.get(span.traceId) ?? [];
      traceSpans.push(span);
      spansByTrace.set(span.traceId, traceSpans);
    }

    for (const [traceId, traceSpans] of spansByTrace) {
      this.flushTrace(traceId, traceSpans);
    }
  }

  private flushTrace(traceId: string, batchSpans: SerializableSpan[]): void {
    // Get or create trace info — accumulates ALL spans across flushes
    const traceInfo = this.activeTraces.get(traceId) ?? {
      startTime: Date.now(),
      spanIds: new Set<string>(),
      allSpans: [],
      started: false,
    };

    // Send trace.start once
    if (!traceInfo.started) {
      const rootSpan = batchSpans[0];
      const input = rootSpan?.attributes?.input ?? {};

      this.ws!.send(
        JSON.stringify({
          type: 'trace.start',
          traceId,
          agentId: this.options.agentName,
          input,
          startTime: traceInfo.startTime,
        } satisfies ClientMessage),
      );
      traceInfo.started = true;
    }

    // Accumulate spans in trace history
    traceInfo.allSpans.push(...batchSpans);

    // Process each span in this batch
    for (const span of batchSpans) {
      if (traceInfo.spanIds.has(span.spanId)) {
        // Already sent nodeStart — send nodeComplete if now ended
        if (span.endTime) {
          this.ws!.send(
            JSON.stringify({
              type: 'trace.nodeComplete',
              traceId,
              nodeId: span.spanId,
              output: span.attributes.output ?? null,
              durationMs: span.duration,
            } satisfies ClientMessage),
          );
        }
        continue;
      }

      // New span — send trace.nodeStart
      traceInfo.spanIds.add(span.spanId);
      this.sendNodeStart(traceId, span, traceInfo.allSpans);
    }

    // Persist trace info
    this.activeTraces.set(traceId, traceInfo);

    // Check if the trace is complete: root span (no parent) must have ended
    this.checkTraceComplete(traceId, traceInfo);
  }

  private sendNodeStart(
    traceId: string,
    span: SerializableSpan,
    allSpans: SerializableSpan[],
  ): void {
    const spanAttrs = span.attributes || {};
    const tokenInput = this.getNumericAttr(spanAttrs, 'tokenInput', 'inputTokens');
    const tokenOutput = this.getNumericAttr(spanAttrs, 'tokenOutput', 'outputTokens');
    const tokenTotal = tokenInput + tokenOutput || this.getNumericAttr(spanAttrs, 'totalTokens');
    const cost = this.getNumericAttr(spanAttrs, 'cost', 'price');
    const elapsedMs = span.duration || (span.endTime ? span.endTime - span.startTime : 0);
    const depth = this.calculateDepth(span, allSpans);

    const nodeStartMessage: ClientMessage = {
      type: 'trace.nodeStart',
      traceId,
      node: {
        id: span.spanId,
        stepId: span.name,
        kind: this.inferStepKind(span.name, spanAttrs),
        parentId: span.parentSpanId || null,
        depth,
        startTime: span.startTime,
        endTime: span.endTime || null,
        durationMs: span.endTime ? span.duration : null,
        status: span.endTime ? 'completed' : 'running',
        input: span.attributes.input ?? {},
        output: span.endTime ? (span.attributes.output ?? null) : null,
        contextSnapshot: {
          depth,
          stepCount: 1,
          tokens: {
            input: tokenInput,
            output: tokenOutput,
            total: tokenTotal,
          },
          cost,
          elapsedMs,
          state: spanAttrs.state ?? spanAttrs.contextState ?? null,
          itemLogLength: Array.isArray(spanAttrs.messages) ? spanAttrs.messages.length : 0,
        },
        stepData: this.buildStepData(spanAttrs, tokenInput, tokenOutput, tokenTotal, cost),
        children: [],
      },
    };
    this.ws!.send(JSON.stringify(nodeStartMessage));
  }

  /**
   * Check if a trace is complete.
   *
   * The interpreter sets a `depth` attribute on each span (0 for the top-level
   * step, incrementing for children). Spans are exported depth-first, so a
   * depth-0 span only arrives after all its children have completed.
   * The trace is complete when a depth-0 span with endTime is present.
   *
   * Falls back to checking if the span's parent is not among exported spans
   * (handles cases where depth attribute is missing).
   */
  private checkTraceComplete(traceId: string, traceInfo: TraceInfo): void {
    // Primary: check for depth-0 span (set by the core interpreter)
    let rootSpan = traceInfo.allSpans.find((s) => {
      const depth = s.attributes?.depth;
      return s.endTime && typeof depth === 'number' && depth === 0;
    });

    // Fallback: find span whose parent is not among exported spans
    if (!rootSpan) {
      const exportedIds = new Set(traceInfo.allSpans.map((s) => s.spanId));
      rootSpan = traceInfo.allSpans.find(
        (s) => s.endTime && !s.parentSpanId && !exportedIds.has(s.parentSpanId ?? ''),
      );
    }

    if (!rootSpan) {
      return;
    }

    // Root span has ended — the full execution is complete
    const totalDuration = traceInfo.allSpans
      .filter((s) => s.endTime)
      .reduce((sum, s) => sum + s.duration, 0);

    this.ws!.send(
      JSON.stringify({
        type: 'trace.complete',
        traceId,
        summary: {
          totalSteps: traceInfo.allSpans.length,
          durationMs: totalDuration,
        },
        endTime: Date.now(),
      } satisfies ClientMessage),
    );

    this.activeTraces.delete(traceId);
  }

  //#endregion

  //#region Depth and Attribute Helpers

  /**
   * Calculate depth using ALL accumulated spans for the trace,
   * not just the current flush batch.
   */
  private calculateDepth(span: SerializableSpan, allSpans: SerializableSpan[]): number {
    // Use the depth attribute set by the interpreter if available
    const depthAttr = span.attributes?.depth;
    if (typeof depthAttr === 'number') {
      return depthAttr;
    }

    // Fall back to walking the parent chain
    let depth = 0;
    let currentSpan = span;
    while (currentSpan.parentSpanId) {
      depth++;
      const parent = allSpans.find((s) => s.spanId === currentSpan.parentSpanId);
      if (!parent) {
        break;
      }
      currentSpan = parent;
    }
    return depth;
  }

  private getNumericAttr(attrs: Record<string, unknown>, ...keys: string[]): number {
    for (const key of keys) {
      const val = attrs[key];
      if (typeof val === 'number') {
        return val;
      }
    }
    return 0;
  }

  //#endregion

  //#region Message Queue and Timer

  private flushMessageQueue(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message) {
        this.ws.send(JSON.stringify(message));
      }
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      if (this.spanBuffer.length > 0) {
        this.flush();
      }
    }, this.options.flushIntervalMs);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  //#endregion

  //#region Span Serialization

  private serializeSpan(span: Span): SerializableSpan {
    const hasSpanImplProperties = (
      s: Span,
    ): s is Span & {
      name: string;
      startTime: number;
      endTime?: number;
      duration: number;
      attributes: Map<string, string | number | boolean>;
      events: SerializableSpan['events'];
    } => {
      return 'name' in s && 'startTime' in s && 'duration' in s;
    };

    if (hasSpanImplProperties(span)) {
      return {
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        startTime: span.startTime,
        endTime: span.endTime,
        attributes: Object.fromEntries(span.attributes.entries()),
        events: span.events,
        duration: span.duration,
      };
    }

    return {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: 'unknown',
      startTime: Date.now(),
      endTime: undefined,
      attributes: {},
      events: [],
      duration: 0,
    };
  }

  private inferStepKind(
    spanName: string,
    spanAttrs?: Record<string, unknown>,
  ): 'run' | 'llm' | 'tool' | 'branch' | 'fork' | 'spawn' | 'loop' {
    const attrKind = spanAttrs?.kind ?? spanAttrs?.stepKind;
    if (
      attrKind === 'run' ||
      attrKind === 'llm' ||
      attrKind === 'tool' ||
      attrKind === 'branch' ||
      attrKind === 'fork' ||
      attrKind === 'spawn' ||
      attrKind === 'loop'
    ) {
      return attrKind;
    }

    const name = spanName.toLowerCase();
    if (name.includes('llm') || name.includes('model')) {
      return 'llm';
    }
    if (name.includes('tool')) {
      return 'tool';
    }
    if (name.includes('branch')) {
      return 'branch';
    }
    if (name.includes('fork')) {
      return 'fork';
    }
    if (name.includes('spawn')) {
      return 'spawn';
    }
    if (name.includes('loop')) {
      return 'loop';
    }
    return 'run';
  }

  private buildStepData(
    spanAttrs: Record<string, unknown>,
    tokenInput: number,
    tokenOutput: number,
    tokenTotal: number,
    cost: number,
  ): Record<string, unknown> {
    const stepKind = String(spanAttrs.stepKind || 'run');
    const extractor = getStepDataExtractor(stepKind);
    const tokenUsage = {
      input: tokenInput,
      output: tokenOutput,
      total: tokenTotal,
    };
    return extractor(spanAttrs, tokenUsage, cost);
  }

  //#endregion
}
