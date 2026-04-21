import type { Span, TraceExporter } from '../types/observability';
import { SpanImpl } from './span-impl';

/** @public No-op trace exporter that silently discards all spans. */
export class NoopExporter implements TraceExporter {
  async export(_spans: Span[]): Promise<void> {
    // No-op
  }
}

/** @internal Test-only record of a trace lifecycle. */
export interface TraceRecord {
  traceId: string;
  input: unknown;
  completed: boolean;
  error?: Error;
}

/** @public Collects SpanImpl instances for test assertions and diagnostics. Non-SpanImpl spans are filtered out. */
export class InMemoryExporter implements TraceExporter {
  readonly spans: SpanImpl[] = [];
  readonly traces: TraceRecord[] = [];

  startTrace(traceId: string, input: unknown): void {
    this.traces.push({
      traceId,
      input,
      completed: false,
    });
  }

  completeTrace(traceId: string, error?: Error): void {
    const record = this.traces.find((t) => t.traceId === traceId);
    if (!record) {
      return;
    }
    record.completed = true;
    record.error = error;
  }

  async export(spans: Span[]): Promise<void> {
    this.spans.push(...spans.filter((s): s is SpanImpl => s instanceof SpanImpl));
  }

  clear(): void {
    this.spans.length = 0;
    this.traces.length = 0;
  }

  getSpansByName(name: string): SpanImpl[] {
    return this.spans.filter((s) => s.name === name);
  }

  getChildSpans(parentSpanId: string): SpanImpl[] {
    return this.spans.filter((s) => s.parentSpanId === parentSpanId);
  }

  getTraceTree(traceId: string): SpanImpl[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }
}
