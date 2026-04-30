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

  /**
   * Explicitly signal that a trace is complete.
   * Called by the harness after execution finishes (success or error).
   * This is the ONLY way a trace.complete message is sent — auto-detection
   * was removed because the interpreter reuses context for loop/branch/fork
   * children, making depth-based heuristics unreliable.
   */
  completeTrace(traceId: string, error?: Error): void {
    const traceInfo = this.activeTraces.get(traceId);
    if (!traceInfo) {
      return;
    }

    let message: ClientMessage;
    if (error) {
      message = {
        type: 'trace.error',
        traceId,
        error: {
          message: error.message,
          stack: error.stack,
        },
        endTime: Date.now(),
      };
    } else {
      const totalDuration = traceInfo.allSpans
        .filter((s) => s.endTime)
        .reduce((sum, s) => sum + s.duration, 0);

      message = {
        type: 'trace.complete',
        traceId,
        summary: {
          totalSteps: traceInfo.allSpans.length,
          durationMs: totalDuration,
        },
        endTime: Date.now(),
      };
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.messageQueue.push(message);
    }

    this.activeTraces.delete(traceId);
  }

  /**
   * Complete all active traces.
   * Called by the harness when execution finishes but the traceId is unknown.
   */
  completeAllTraces(): void {
    for (const traceId of [
      ...this.activeTraces.keys(),
    ]) {
      this.completeTrace(traceId);
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

  /**
   * Flush all pending traces and messages to the server.
   * Returns a promise that resolves when all data has been sent.
   * Use this before process exit to ensure traces are saved.
   */
  async flushTraces(): Promise<void> {
    // Flush any buffered spans first
    if (this.spanBuffer.length > 0) {
      await this.flush();
    }

    // Flush message queue
    this.flushMessageQueue();

    // Wait for WebSocket to finish sending (give it a moment to drain)
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Use a small delay to allow the WebSocket to send buffered data
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Complete all traces and flush them to the server.
   * Use this before process exit to ensure all traces are saved.
   */
  async completeAllAndFlush(): Promise<void> {
    // Complete all active traces
    const traceIds = [
      ...this.activeTraces.keys(),
    ];
    for (const traceId of traceIds) {
      this.completeTrace(traceId);
    }

    // Flush everything
    await this.flushTraces();

    // Give extra time for the server to process and save
    await new Promise((resolve) => setTimeout(resolve, 500));
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
    // Note: completion is signaled explicitly via completeTrace(), NOT auto-detected.
    // Auto-detection is unreliable because the core interpreter reuses context objects
    // for loop/branch/fork children, so all steps have the same depth.
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
  ): 'run' | 'llm' | 'tool' | 'branch' | 'fork' | 'spawn' | 'loop' | 'every' {
    const attrKind = spanAttrs?.kind ?? spanAttrs?.stepKind;
    if (
      attrKind === 'run' ||
      attrKind === 'llm' ||
      attrKind === 'tool' ||
      attrKind === 'branch' ||
      attrKind === 'fork' ||
      attrKind === 'spawn' ||
      attrKind === 'loop' ||
      attrKind === 'every'
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
    if (name.includes('every')) {
      return 'every';
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
