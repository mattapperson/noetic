# Observability

> **Depends On:** (none — defines its own primitives)
> **Exports:** `Span`, `TraceExporter`, `LayerTraceSpan`

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

No user instrumentation needed. The trace tree mirrors the execution tree because every step, inParallel, spawn, and loop creates a child span from the context.

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
import { setTraceExporter } from '@noetic-tools/core';
import { DatadogExporter } from '@noetic/datadog';

setTraceExporter(new DatadogExporter({ apiKey: process.env.DD_API_KEY }));
```

---

## GenAI Semantic Conventions

callModel step spans follow OpenTelemetry GenAI semantic conventions:

| Attribute | Type | Description |
|-----------|------|-------------|
| `gen_ai.system` | string | Provider (e.g. `'anthropic'`) |
| `gen_ai.request.model` | string | Model ID |
| `gen_ai.usage.input_tokens` | number | Input token count |
| `gen_ai.usage.output_tokens` | number | Output token count |
| `gen_ai.usage.cached_input_tokens` | number | Prompt tokens served from the provider's cache |
| `gen_ai.usage.cache_write_tokens` | number | Prompt tokens written into the provider's cache |
| `gen_ai.cost` | number | USD cost |

The two cache attributes are **absent, not zero**, when the provider reports no figures — a consumer must be able to tell "nothing was cached" from "this provider does not say", since the runtime steers re-anchoring on that distinction (spec 11).

invokeTool step spans include:

| Attribute | Type | Description |
|-----------|------|-------------|
| `tool.name` | string | Tool name |
| `tool.needs_approval` | boolean | Whether the tool required approval |

The harness emits one `llm.call` span per model call (one per tool round) and one `tool.call` span per function call, nested under the calling context's span. Both are flushed to the configured `traceExporter` when the `callModel` invocation settles. A harness constructed without a `traceExporter` uses a `NoopExporter`, so emission is always safe.

---

## Workflow Run Span

`parseAndRunWorkflow` opens a root `workflow.run` span that carries the static workflow graph — the *potential paths* of the DAG, independent of which routes actually execute. Model and tool spans for the run nest under it, so the trace tree mirrors the declared workflow with the executed path overlaid. The span is exported when the run settles.

| Attribute | Type | Description |
|-----------|------|-------------|
| `noetic.workflow.document` | string | Full JSON-serialised `WorkflowDocument` (lossless) |
| `noetic.workflow.version` | number | Workflow document schema version |
| `noetic.workflow.node_count` | number | Count of declared nodes |
| `noetic.workflow.nodes` | string | JSON array of `{ id, kind }` for every declared node |
| `noetic.workflow.edges` | string | JSON array of `{ from, to }` parent→child edges |

---

## Context Anchoring Attributes

Each callModel step stamps how its view was banded onto the step's span, so an expensive run can be traced back to the layer that keeps invalidating the prompt prefix (spec 11, Prompt-Cache Anchoring). Nothing is stamped when anchoring is switched off.

| Attribute | Type | Description |
|-----------|------|-------------|
| `noetic.context.epoch.id` | string | Id of the anchoring epoch this assembly belongs to |
| `noetic.context.epoch.age` | number | Assemblies served by this epoch, including this one |
| `noetic.context.reanchor_reason` | string | Why the epoch re-anchored, on the assembly that did |
| `noetic.context.anchor_tokens` | number | Tokens in the anchor band (the cache-stable prefix) |
| `noetic.context.live_tokens` | number | Tokens in the live band |
| `noetic.context.delta_tokens` | number | Tokens spent superseding stale anchors |
| `noetic.context.layer_placements` | string | JSON array of `{ id, placement, served, changed }` |
| `noetic.context.layer_churn` | string | JSON array of `{ id, rate, rebillTokens }` |

`rebillTokens` estimates what a layer's changes would have cost in re-sent prefix had it not been pinned — the number that tells a developer which layer is worth moving to the live band or giving a `renderDelta`.

---

## Context Layer Trace Spans

Every context layer hook invocation produces a trace span (see also `11-context-layer-system`).

```typescript
interface LayerTraceSpan {
  /** Layer that produced this span. */
  layerId: string;
  /** Which hook was invoked. */
  hook: 'init' | 'recall' | 'store' | 'onSpawn' | 'onReturn' | 'onComplete' | 'dispose';
  /** Wall-clock duration in milliseconds. */
  duration: number;
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
