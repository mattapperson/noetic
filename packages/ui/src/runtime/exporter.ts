/**
 * @noetic/ui Trace Exporter
 *
 * Implements the TraceExporter interface to forward trace spans
 * to the Noetic UI WebSocket server for real-time visualization.
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

/**
 * Noetic UI Trace Exporter
 *
 * Receives completed trace spans from the Noetic core runtime and forwards
 * them to the UI WebSocket server for real-time visualization and recording.
 *
 * @example
 * ```typescript
 * import { setTraceExporter } from '@noetic/core';
 * import { NoeticUITraceExporter } from '@noetic/ui/runtime';
 *
 * if (process.env.NOETIC_UI_ENABLED) {
 *   const exporter = new NoeticUITraceExporter({ port: 3333 });
 *   setTraceExporter(exporter);
 * }
 * ```
 */
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
  private activeTraces = new Map<
    string,
    {
      startTime: number;
      spanIds: Set<string>;
    }
  >();

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
    // Convert spans to serializable format
    const serializableSpans = spans.map((span) => this.serializeSpan(span));

    // Add to buffer
    this.spanBuffer.push(...serializableSpans);

    // Trim buffer if needed
    if (this.spanBuffer.length > this.options.bufferSize) {
      this.spanBuffer = this.spanBuffer.slice(-this.options.bufferSize);
    }

    // If connected, flush immediately
    if (this.ws?.readyState === WebSocket.OPEN) {
      await this.flush();
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
      // Queue messages for later if disconnected
      this.messageQueue.push(message);

      // Trim queue if needed
      if (this.messageQueue.length > this.options.bufferSize) {
        this.messageQueue = this.messageQueue.slice(-this.options.bufferSize);
      }
    }
  }

  /**
   * Close the WebSocket connection and cleanup
   */
  close(): void {
    this.stopFlushTimer();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.spanBuffer = [];
    this.messageQueue = [];
  }

  /** Get current connection state */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Get buffered span count */
  getBufferedSpanCount(): number {
    return this.spanBuffer.length;
  }

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

        // Register agent if agentName is provided
        if (this.options.agentName) {
          this.sendEvent({
            type: 'agent.register',
            agentId: this.options.agentName,
            agentName: this.options.agentName,
            timestamp: Date.now(),
          });
        }

        // Flush any queued messages and span buffer
        this.flushMessageQueue();
        void this.flush();
      });

      this.ws.on('close', () => {
        this.isConnecting = false;
        this.handleDisconnect();
      });

      this.ws.on('error', (error: Error) => {
        this.isConnecting = false;
        // Silently handle errors - UI is optional
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
      console.debug('[Noetic UI] Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * 2 ** (this.reconnectAttempts - 1), 30000);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

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

    // Process each trace
    for (const [traceId, traceSpans] of spansByTrace) {
      await this.flushTrace(traceId, traceSpans);
    }
  }

  private async flushTrace(traceId: string, spans: SerializableSpan[]): Promise<void> {
    // Check if this is a new trace
    const isNewTrace = !this.activeTraces.has(traceId);
    const traceInfo = this.activeTraces.get(traceId) ?? {
      startTime: Date.now(),
      spanIds: new Set(),
    };

    if (isNewTrace) {
      // Get input from the first span (root span) if available
      const rootSpan = spans[0];
      const input = rootSpan?.attributes?.input ?? {};

      // Send trace.start for new traces
      const startMessage: ClientMessage = {
        type: 'trace.start',
        traceId,
        agentId: this.options.agentName,
        input,
        startTime: traceInfo.startTime,
      };
      this.ws!.send(JSON.stringify(startMessage));
    }

    // Process each span
    for (const span of spans) {
      const isNewSpan = !traceInfo.spanIds.has(span.spanId);

      if (isNewSpan) {
        // Send nodeStart for all new spans (even if already ended)
        // This ensures the server creates the node before nodeComplete updates it
        // Build context snapshot from span data and attributes
        const spanAttrs = span.attributes || {};
        const tokenInput =
          typeof spanAttrs.tokenInput === 'number'
            ? spanAttrs.tokenInput
            : typeof spanAttrs.inputTokens === 'number'
              ? spanAttrs.inputTokens
              : 0;
        const tokenOutput =
          typeof spanAttrs.tokenOutput === 'number'
            ? spanAttrs.tokenOutput
            : typeof spanAttrs.outputTokens === 'number'
              ? spanAttrs.outputTokens
              : 0;
        const tokenTotal =
          tokenInput + tokenOutput ||
          (typeof spanAttrs.totalTokens === 'number' ? spanAttrs.totalTokens : 0);

        const cost =
          typeof spanAttrs.cost === 'number'
            ? spanAttrs.cost
            : typeof spanAttrs.price === 'number'
              ? spanAttrs.price
              : 0;

        const elapsedMs = span.duration || (span.endTime ? span.endTime - span.startTime : 0);

        const nodeStartMessage: ClientMessage = {
          type: 'trace.nodeStart',
          traceId,
          node: {
            id: span.spanId,
            stepId: span.name,
            kind: this.inferStepKind(span.name, spanAttrs),
            parentId: span.parentSpanId || null,
            depth: this.calculateDepth(span, spans),
            startTime: span.startTime,
            endTime: span.endTime || null,
            durationMs: span.endTime ? span.duration : null,
            status: span.endTime ? 'completed' : 'running',
            input: span.attributes.input ?? {},
            output: span.endTime ? (span.attributes.output ?? null) : null,
            contextSnapshot: {
              depth: this.calculateDepth(span, spans),
              stepCount: spans.length,
              tokens: {
                input: tokenInput,
                output: tokenOutput,
                total: tokenTotal,
              },
              cost: cost,
              elapsedMs: elapsedMs,
              state: spanAttrs.state ?? spanAttrs.contextState ?? null,
              itemLogLength: Array.isArray(spanAttrs.messages) ? spanAttrs.messages.length : 0,
            },
            stepData: this.buildStepData(spanAttrs, tokenInput, tokenOutput, tokenTotal, cost),
            children: [],
          },
        };
        this.ws!.send(JSON.stringify(nodeStartMessage));
        traceInfo.spanIds.add(span.spanId);
      } else if (span.endTime) {
        // Previously seen span that just ended - send nodeComplete
        const nodeCompleteMessage: ClientMessage = {
          type: 'trace.nodeComplete',
          traceId,
          nodeId: span.spanId,
          output: span.attributes.output ?? null,
          durationMs: span.duration,
        };
        this.ws!.send(JSON.stringify(nodeCompleteMessage));
      }
    }

    // Update trace info
    this.activeTraces.set(traceId, traceInfo);

    // Check if all spans in this trace are complete
    const allComplete = spans.every((s) => s.endTime);
    if (allComplete && spans.length > 0) {
      // Send trace.complete
      const completedSpans = spans.filter((s) => s.endTime);
      const totalDuration = completedSpans.reduce((sum, s) => sum + s.duration, 0);

      const completeMessage: ClientMessage = {
        type: 'trace.complete',
        traceId,
        summary: {
          totalSteps: spans.length,
          durationMs: totalDuration,
        },
        endTime: Date.now(),
      };
      this.ws!.send(JSON.stringify(completeMessage));

      // Clean up trace tracking
      this.activeTraces.delete(traceId);
    }
  }

  private calculateDepth(span: SerializableSpan, allSpans: SerializableSpan[]): number {
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

  private serializeSpan(span: Span): SerializableSpan {
    // Type guard function to check if span has SpanImpl properties
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

    // Fallback for spans that don't have SpanImpl properties
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
    // Prefer explicit attribute — check each valid value so TypeScript narrows the type
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

    // Fall back to name-based inference
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

  /**
   * Build stepData object based on step type and span attributes
   * Uses the step data extractor registry for extensibility
   */
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
}
