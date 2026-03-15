export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  end(): void;
}

export interface TraceExporter {
  export(spans: Span[]): Promise<void>;
}

export interface MemoryTraceSpan {
  layerId: string;
  hook: 'init' | 'recall' | 'store' | 'onSpawn' | 'onReturn' | 'onComplete' | 'dispose';
  durationMs: number;
  status: 'ok' | 'error' | 'timeout' | 'skipped';
  budget?: { allocated: number; used: number; yielded: number };
  itemCount?: number;
  error?: { message: string; stack?: string };
}
