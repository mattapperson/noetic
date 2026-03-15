import type { Span, TraceExporter } from '../types/observability';
import type { SpanImpl } from './span-impl';

export class NoopExporter implements TraceExporter {
  async export(spans: Span[]): Promise<void> {
    // No-op
  }
}

export class InMemoryExporter implements TraceExporter {
  readonly spans: SpanImpl[] = [];

  async export(spans: Span[]): Promise<void> {
    this.spans.push(...(spans as SpanImpl[]));
  }

  clear(): void {
    this.spans.length = 0;
  }

  getSpansByName(name: string): SpanImpl[] {
    return this.spans.filter(s => s.name === name);
  }

  getChildSpans(parentSpanId: string): SpanImpl[] {
    return this.spans.filter(s => s.parentSpanId === parentSpanId);
  }

  getTraceTree(traceId: string): SpanImpl[] {
    return this.spans.filter(s => s.traceId === traceId);
  }
}

let globalExporter: TraceExporter = new NoopExporter();

export function setTraceExporter(exporter: TraceExporter): void {
  globalExporter = exporter;
}

export function getTraceExporter(): TraceExporter {
  return globalExporter;
}
