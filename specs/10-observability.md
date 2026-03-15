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
import { setTraceExporter } from '@orchid/core';
import { DatadogExporter } from '@orchid/datadog';

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
