/**
 * @noetic/ui Trace Exporter
 *
 * Implements the TraceExporter interface to forward trace spans
 * to the Noetic UI WebSocket server for real-time visualization.
 */

import type { Span, TraceExporter } from '@noetic/core';
import WebSocket from 'ws';
import type { ExporterOptions, SerializableSpan, ServerMessage } from './types';

/** Default exporter options */
const DEFAULT_OPTIONS: Required<ExporterOptions> = {
  port: 3333,
  host: 'localhost',
  bufferSize: 100,
  flushIntervalMs: 100,
  autoReconnect: true,
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
  private messageQueue: ServerMessage[] = [];

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
  sendEvent(message: ServerMessage): void {
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
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Get pending span count in buffer */
  get pendingSpanCount(): number {
    return this.spanBuffer.length;
  }

  /** Get pending message count in queue */
  get pendingMessageCount(): number {
    return this.messageQueue.length;
  }

  private connect(): void {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.isConnecting = true;
    const wsUrl = `ws://${this.options.host}:${this.options.port}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;

        // Flush any queued messages
        this.flushMessageQueue();
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

    // Send spans as node.data events
    for (const span of spans) {
      const stepKind = this.inferStepKind(span.name);
      const message: ServerMessage = {
        type: 'node.data',
        nodeId: span.spanId,
        data: {
          id: span.spanId,
          stepId: span.name,
          kind: stepKind,
          startTime: span.startTime,
          endTime: span.endTime ?? null,
          durationMs: span.duration,
          status: span.endTime ? 'completed' : 'running',
        },
      };

      this.ws.send(JSON.stringify(message));
    }
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
  ): 'run' | 'llm' | 'tool' | 'branch' | 'fork' | 'spawn' | 'loop' {
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
}
