# Observability

> **Depends On:** (none — defines its own primitives)
> **Exports:** `Span`, `TraceExporter`, `LayerTraceSpan`, `ExecutionSpan`

---

## Automatic Trace Spans

Every `Context` carries a span (`Context.span`, see `07-context-and-event-log`). The framework opens spans at the points where work leaves the current context — a model call, a tool call, a decision, a child context — and nests each under the span of the context that started it. Steps that stay in their context (`runCode`, `loop`, `conditional`, …) open none; they add events and attributes to `ctx.span` instead.

| Span | Opened by | Parent |
|------|-----------|--------|
| `workflow.run` | `parseAndRunWorkflow` | none (root) |
| `spawn` | each `spawn` step, around its child context | `ctx.span` |
| `inParallel.path` | each `inParallel` path, around its child context | `ctx.span` |
| `llm.call` | each model call (one per tool round) | `ctx.span` |
| `tool.call` | each function call of a model call | its `llm.call` |
| `tool.call` | each `invokeTool` step, around validation, the steering gate, and execution | `ctx.span` |
| `decide.call` | each `decide` step | `ctx.span` |
| `layer.hook` | each context layer hook call (see Context Layer Trace Spans) | the span of the context the hook runs in |

```
[workflow.run]                                  <- root span
  [spawn] noetic.node.id=ralph-iteration        <- iteration 1, fresh context
    [llm.call] gen_ai.request.model=claude-sonnet
      gen_ai.usage.input_tokens: 1500
      gen_ai.usage.output_tokens: 340
      gen_ai.cost: 0.0067
      [tool.call] tool.name=shell
    loop.verdict: { loop: "react-loop", iteration: 1, stop: true, reason: "No tool calls in last response" }
  loop.verdict: { loop: "ralph-wiggum-loop", iteration: 1, stop: false, reason: "Verification failed" }
  [spawn] noetic.node.id=ralph-iteration        <- iteration 2, fresh context
    ...
  loop.verdict: { loop: "ralph-wiggum-loop", iteration: 2, stop: true, reason: "Verification passed" }
```

No user instrumentation needed. Because child contexts carry their own spans, events added inside a `spawn` child or an `inParallel` path (such as a nested loop's `loop.verdict`) land on that child's span, not the parent's.

---

## Child Context Spans

`spawn` and `inParallel` run their children in fresh contexts, and each child context gets a span of its own: `spawn` for a spawn child, `inParallel.path` for each path. The span opens with the child context and ends when the child settles — on success, on error, and on cancellation — and is then exported to the harness `traceExporter`. A `spawn` span also covers the layers' `onReturn` merge; an `inParallel.path` span covers the path's `onSpawn` seed and `onReturn` merge.

| Attribute | Type | On | Description |
|-----------|------|----|-------------|
| `noetic.node.id` | string | both | `spawn`: the spawn step's id. `inParallel.path`: the path step's id |
| `noetic.parallel.id` | string | `inParallel.path` | Id of the `inParallel` step |
| `noetic.parallel.index` | number | `inParallel.path` | Zero-based position of the path among its siblings |
| `noetic.error.kind` | string | both | `NoeticError` kind the child failed with; absent on success |
| `error` | boolean | both | `true` when the child failed for any reason but cancellation |

A cancelled child — a race loser, a sibling aborted by fail-fast, a parent abort — gets `noetic.error.kind: "cancelled"` and no `error`, since cancellation is not a fault. An `inParallel` path that never starts (queued behind the concurrency limit when fail-fast aborts it, or still queued when a race settles) has its span ended the same way when the `inParallel` settles.

---

## Loop Verdict Events

A loop opens no span of its own. After each verdict it adds a `loop.verdict` event to the enclosing span (`ctx.span`), so the events land on whatever span the loop's context carries: the `spawn` or `inParallel.path` span inside a child context, otherwise the run's span (for a JSON workflow, `workflow.run`). Attributes are `loop` (step id), `iteration`, `stop`, and `reason` when the verdict has one; `feedback` is never recorded. See `05-loop-and-until` (Verdict Traces) for the full table.

---

## Spawn Summary Failure Events

When a layer's `onReturn` hook fails at a `spawn` or `inParallel` boundary, the runtime adds a `spawn.summary_failed` event to the child's span (`spawn` or `inParallel.path`) with attributes `stepId`, `layerId`, and `message`, alongside the `spawn_summary_failed` layer diagnostic (see `09-error-model`, Spawn with Summary Failure).

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

Each harness takes its exporter at construction; there is no process-wide exporter, so two harnesses in one process can trace to different backends. A harness built without one uses a `NoopExporter`:

```typescript
import { AgentHarness } from '@noetic-tools/core';
import { DatadogExporter } from '@noetic/datadog';

const harness = new AgentHarness({
  name: 'traced-agent',
  agentGraph: agent,
  params: {},
  traceExporter: new DatadogExporter({ apiKey: process.env.DD_API_KEY }),
});
```

Every span the harness opens — model, tool, decision, child-context, layer-hook, and workflow-run spans — is exported to that harness's `traceExporter`.

Tracing never changes behavior. An exporter that rejects or throws is reported once per failed export with `console.warn` and swallowed: the model call, tool call, decision, child context, layer hook, or workflow run it traced keeps its own result or error. A gating `beforeToolCall` that allowed a call still allows it, and a layer hook that succeeded still commits its state.

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

`tool.call` spans — a model's function calls and `invokeTool` steps alike — include:

| Attribute | Type | Description |
|-----------|------|-------------|
| `tool.name` | string | Tool name |
| `tool.needs_approval` | boolean | Whether the tool required approval |
| `tool.approval` | string | How the approval stage settled the call: `approved`, `denied`, or `none_configured` (no harness approver, so the call ran unapproved). Absent when the tool does not need approval or a `beforeToolCall` layer stopped the call first (`02-step-variants`) |
| `noetic.node.id` | string | The `callModel` step that made the call, or the `invokeTool` step |

The harness emits one `llm.call` span per model call (one per tool round) and one `tool.call` span per function call, nested under the calling context's span. Both are flushed to the configured `traceExporter` when the `callModel` invocation settles. A function call's `tool.call` span marks that the call happened; it is closed as soon as it opens, and carries no timing.

An `invokeTool` step's `tool.call` span covers the whole step — input validation, the steering gate, and execution — and is exported when the step settles. A failure stamps `noetic.error.kind` and `error: true`, as on child context spans; a steering denial reads `noetic.error.kind: "steering_denied"`.

A harness constructed without a `traceExporter` uses a `NoopExporter`, so emission is always safe.

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

Each callModel step stamps how its view was banded onto its first `llm.call` span — the first tool round of its first attempt — so an expensive run can be traced back to the layer that keeps invalidating the prompt prefix (spec 11, Prompt-Cache Anchoring). The view is assembled once per step: a steering retry re-sends it and later tool rounds only extend it, so their `llm.call` spans carry none of these attributes, and each step's values stay on its own span. Nothing is stamped when anchoring is switched off.

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

## Channel Warnings

Channel conditions that lose data or risk a stall without failing the run (see `06-channels`) are recorded as a `channel.warning` span event (`NoeticEvent.CHANNEL_WARNING`). Channel state is shared by every root execution on a harness, so the event is added to the span of **each live root context** — a root with a `run()` in flight whose span is a harness span (`SpanImpl`) and whose harness has a real `traceExporter`. When no such span exists (no root running, or tracing is off) the warning is printed with `console.warn` instead, so it is never silently lost.

| Attribute | Type | Description |
|-----------|------|-------------|
| `kind` | string | `'overflow_drop'` — an external `handle.send()` hit a full queue and dropped the oldest item; `'subscriber_drop'` — an external subscriber's private buffer (1000) filled and dropped its oldest value; `'unbounded_wait'` — a `recv` or parked `send` is waiting with `timeout: 0`, so nothing will time it out |
| `channelName` | string | The channel the warning is about |
| `capacity` | number | `overflow_drop` / `subscriber_drop` only: the queue capacity or subscriber buffer size that was hit |
| `operation` | string | `unbounded_wait` only: `'recv'` or `'send'` |
| `message` | string | Human-readable description, the same text the console fallback prints |

---

## Context Layer Trace Spans

Every call of a context layer hook — `init`, `recall`, `store`, `onSpawn`, `onReturn`, `onParentUpdate`, `onComplete`, `dispose`, `onDecision`, `beforeToolCall`, `afterModelCall`, `projectHistory`, and `onItemAppend` — is recorded once, as a `layer.hook` record shaped as a `LayerTraceSpan` (see also `11-context-layer-system`):

```typescript
interface LayerTraceSpan {
  /** Layer that produced this record. */
  layerId: string;
  /** Which hook was invoked. */
  hook:
    | 'init' | 'recall' | 'store' | 'onSpawn' | 'onReturn' | 'onParentUpdate' | 'onComplete'
    | 'dispose' | 'onDecision' | 'beforeToolCall' | 'afterModelCall' | 'projectHistory' | 'onItemAppend';
  /** Wall-clock duration in milliseconds; 0 when skipped. */
  duration: number;
  /** How the call ended. */
  status: 'ok' | 'error' | 'timeout' | 'skipped';
  /** For recall: tokens allocated vs. tokens used. */
  budget?: { allocated: number; used: number; yielded: number };
  /** For recall: number of items injected. */
  itemCount?: number;
  /** Error details if status is 'error' or 'timeout'. */
  error?: { message: string; stack?: string };
}
```

| `status` | When |
|----------|------|
| `ok` | The hook resolved |
| `error` | The hook threw or rejected |
| `timeout` | The hook outran its `timeouts` entry; `error.message` is `Timeout after <ms>ms` |
| `skipped` | The layer defines the hook but the lifecycle did not call it: the layer is disabled (its `init` failed under `onInitError: 'disable'`), `init` found state already kept for the execution, or `onReturn` found no child state to merge |

For `recall`, `budget.allocated` is the layer's token budget, `budget.used` is what its output costs (`tokenCount`, or the estimate for a string), and `budget.yielded` is `allocated − used`, floored at 0 — the budget the layer left unspent. A recall that returns nothing reports `itemCount: 0` and `used: 0`.

### Span or Event

The record's form depends on the `ExecutionContext` the hook runs with. `@noetic-tools/context` runs the hooks but cannot import the runtime that owns the span tree, so the context carries the means to grow it:

```typescript
interface ExecutionContext {
  // ...
  trace: {
    setAttribute(key: string, value: string | number | boolean): void;
    addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
    /** Opens a span under the context's span. Optional. */
    createSpan?(name: string): ExecutionSpan;
  };
}

interface ExecutionSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  /** Ends the span and exports it to the harness `traceExporter`. */
  end(): Promise<void>;
}
```

- **With `createSpan`** (every context the runtime builds): each record is a `layer.hook` child span of the context's span. The span opens before the hook runs and ends when it settles — on success, error, or timeout — and is then exported to the harness `traceExporter`, like a child-context span. A skipped hook gets a zero-length span, so every record lives in one place. A span times itself, so it carries no duration attribute:

  | Attribute | Type | Description |
  |-----------|------|-------------|
  | `noetic.layer.id` | string | `layerId` |
  | `noetic.layer.hook` | string | `hook` |
  | `noetic.layer.status` | string | `status` |
  | `noetic.layer.item_count` | number | `itemCount` (recall) |
  | `noetic.layer.budget.allocated` / `.used` / `.yielded` | number | `budget` (recall) |
  | `error` | boolean | `true` on `error` and `timeout` |
  | `error.message` | string | `error.message` (the stack is not recorded) |

- **Without `createSpan`** (a hand-built context, such as a test's): each record is a `layer.hook` event (`NoeticEvent.LAYER_HOOK`) on the context's span instead. Event attributes hold only scalars, so the fields flatten to `layerId`, `hook`, `duration`, `status`, `itemCount`, `budget.allocated`, `budget.used`, `budget.yielded`, and `error.message`.

A call is never recorded both ways, so a backend sees each hook call once.


### Where Records Land

`onSpawn` under the parent's span; `onReturn` and `onParentUpdate` under the child's span (`spawn` or `inParallel.path`; `onReturn` next to any `spawn.summary_failed`); every other hook under the span of the context it runs for. A peek recall (a render-only preview, such as the inspector's) records nothing, and neither does an eventual layer served from its recall cache, since no hook runs.

### Cost

Every hook call opens one span, with no sampling. The steering and pipeline hooks run no more often than the runtime's other spans: `beforeToolCall` once per tool call (as `tool.call`), `afterModelCall` once per model round (as `llm.call`), `onDecision` once per decision (as `decide.call`), `projectHistory` once per assembled view, and `onItemAppend` once per appended input. So the overhead per call is one span object and one `export` call per layer that defines the hook — the same order as `recall`, which is already traced per assembly. Exporters that ship spans over the network should batch, as they already must for model and tool spans.
