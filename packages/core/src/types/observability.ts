/** @public A trace span representing a unit of work within the observability pipeline. */
export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  end(): void;
}

/** @public Backend that receives and persists completed trace spans. */
export interface TraceExporter {
  /**
   * Explicitly start a trace.
   * Called once at the beginning of agent execution.
   */
  startTrace?(traceId: string, input: unknown): void;
  export(spans: Span[]): Promise<void>;
  /** Called when a trace completes (agent execution finished). */
  completeTrace?(traceId: string): void;
}

/** @public Diagnostic span recording a single memory layer hook invocation and its outcome. */
export interface MemoryTraceSpan {
  layerId: string;
  hook: 'init' | 'recall' | 'store' | 'onSpawn' | 'onReturn' | 'onComplete' | 'dispose';
  durationMs: number;
  status: 'ok' | 'error' | 'timeout' | 'skipped';
  budget?: {
    allocated: number;
    used: number;
    yielded: number;
  };
  itemCount?: number;
  error?: {
    message: string;
    stack?: string;
  };
}
