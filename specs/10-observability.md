# Observability

> **Depends On:** (none — defines its own primitives)
> **Exports:** `Span`, `TraceExporter`, `MemoryTraceSpan`

---

## Automatic Trace Spans

Every step variant automatically creates OpenTelemetry-compatible trace spans via the `Context.span` field (see `07-context-and-event-log`).

```
[ralph-wiggum-loop]                     <- root span
  [ralph-iteration-1]                   <- spawn span (fresh context)
    [react-loop]                        <- loop span
      [react-step] model=claude-sonnet  <- step span (LLM call)
        gen_ai.usage.input_tokens: 1500
        gen_ai.usage.output_tokens: 340
        gen_ai.cost: 0.0067
      [react-step] tool=shell           <- step span (tool call)
        tool.name: shell
        tool.args: { command: "npm test" }
    loop.verdict: { stop: false, reason: "Verification failed" }
  [ralph-iteration-2]                   <- spawn span (fresh context)
    [react-loop]
      ...
  loop.verdict: { stop: true, reason: "Verification passed" }
```

No user instrumentation needed. The trace tree mirrors the execution tree because every step, fork, spawn, and loop creates a child span from the context.

---

## Span Export Lifecycle

The interpreter exports each step's span twice, providing real-time visibility into execution progress:

1. **Start export (fire-and-forget):** When a step begins execution, the interpreter calls `TraceExporter.export()` with the span in an `"in_progress"` status. This call is **not awaited** — it fires immediately so downstream consumers (e.g., a UI node graph) can render the step as running without blocking the interpreter.

2. **End export (awaited):** When a step completes, the interpreter calls `span.end()`, populates final attributes (output, `gen_ai.usage.*`, `gen_ai.cost`, status), and calls `TraceExporter.export()` again. This call **is awaited** to guarantee the completed span is durably recorded before the interpreter moves on.

```
step begins
  └─ span created, status = "in_progress"
  └─ exporter.export([span])          ← fire-and-forget (not awaited)
  └─ step executes...
step completes
  └─ span.end(), final attributes set, status = "ok" | "error"
  └─ await exporter.export([span])    ← awaited
```

The two-phase approach ensures that:

- **Liveness:** Consumers see steps appear as soon as execution starts, enabling real-time progress indicators.
- **Correctness:** The final export is awaited, so completed span data (tokens, cost, output) is never lost even under backpressure.
- **Non-blocking start:** The fire-and-forget start export cannot stall the interpreter. If the exporter is slow or unavailable, step execution proceeds unimpeded.

Exporters receive the same `Span` object in both calls. They distinguish phases via the span's `status` attribute: `"in_progress"` for the start export, `"ok"` or `"error"` for the end export.

---

## `Span` Interface

```typescript
interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  end(): void;
}
```

---

## `TraceExporter` Interface

```typescript
interface TraceExporter {
  export(spans: Span[]): Promise<void>;
}
```

Custom exporters plug in:

```typescript
import { setTraceExporter } from '@noetic/core';
import { DatadogExporter } from '@noetic/datadog';

setTraceExporter(new DatadogExporter({ apiKey: process.env.DD_API_KEY }));
```

---

## GenAI Semantic Conventions

LLM step spans follow OpenTelemetry GenAI semantic conventions:

| Attribute | Type | Description |
|-----------|------|-------------|
| `gen_ai.system` | string | Provider (e.g. `'anthropic'`) |
| `gen_ai.request.model` | string | Model ID |
| `gen_ai.usage.input_tokens` | number | Input token count |
| `gen_ai.usage.output_tokens` | number | Output token count |
| `gen_ai.cost` | number | USD cost |

Tool step spans include:

| Attribute | Type | Description |
|-----------|------|-------------|
| `tool.name` | string | Tool name |
| `tool.needs_approval` | boolean | Whether the tool required approval |

---

## Memory Layer Trace Spans

Every memory layer hook invocation produces a trace span (see also `11-memory-layer-system`).

```typescript
interface MemoryTraceSpan {
  /** Layer that produced this span. */
  layerId: string;
  /** Which hook was invoked. */
  hook: 'init' | 'recall' | 'store' | 'onSpawn' | 'onReturn' | 'onComplete' | 'dispose';
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Whether the hook succeeded. */
  status: 'ok' | 'error' | 'timeout' | 'skipped';
  /** For recall: tokens allocated vs. tokens used. */
  budget?: { allocated: number; used: number; yielded: number };
  /** For recall: number of items injected. */
  itemCount?: number;
  /** Error details if status is 'error' or 'timeout'. */
  error?: { message: string; stack?: string };
}
```
