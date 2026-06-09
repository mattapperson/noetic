import type { Span, TraceExporter } from '@noetic-tools/types';
import { SpanImpl } from './span-impl';

/** @public No-op trace exporter that silently discards all spans. */
export class NoopExporter implements TraceExporter {
  async export(_spans: Span[]): Promise<void> {
    // No-op
  }
}

/** @public Collects SpanImpl instances for test assertions and diagnostics. Non-SpanImpl spans are filtered out. */
export class InMemoryExporter implements TraceExporter {
  readonly spans: SpanImpl[] = [];

  async export(spans: Span[]): Promise<void> {
    this.spans.push(...spans.filter((s): s is SpanImpl => s instanceof SpanImpl));
  }

  clear(): void {
    this.spans.length = 0;
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
