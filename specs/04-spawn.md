# Spawn: Child Execution with Context Boundary

> **Depends On:** `01-step-type` (Step<I,O>), `07-context-and-event-log` (Context, Item, ItemLog), `11-memory-layer-system` (MemoryLayer.onSpawn/onReturn)
> **Exports:** `spawn()`, `SpawnOpts`

---

## Overview

`spawn` is the most important variant. It's what makes Ralph Wiggum loops, recursive LLMs, and Slate thread weaving possible. Without it, you can't express "run this work with a different context window."

```typescript
interface SpawnOpts<I, O> {
  id: string;
  child: Step<I, O>;
  memory?: MemoryLayer[];
  timeout?: number;
  /**
   * Per-step subprocess adapter override. Takes precedence over the harness
   * default when the interpreter dispatches this spawn. See "SubprocessAdapter
   * Routing" below.
   */
  subprocess?: SubprocessAdapter;
}
```

---

## Design

The child starts with an **empty ItemLog** by default. All context flow across the spawn boundary is controlled by memory layers:

- **`onSpawn` hooks** provide items to the child's initial ItemLog and set up child-side layer state.
- **`onReturn` hooks** transform the child's result before it reaches the parent. Each layer's `onReturn` receives the previous result, forming a transformation pipeline.

The optional `memory` field on `StepSpawn` provides **spawn-local memory layers** that replace parent layer propagation. When `memory` is set, only the specified layers are active in the child — parent layers do not propagate. This gives full isolation control.

When `memory` is not set, parent memory layers propagate to the child normally, and each layer's `onSpawn` hook determines what state crosses the boundary:

- A layer can return `{ childState }` to provide initial state in the child.
- A layer can return `null` to disable itself in the child.
- A layer can inject items into the child's initial ItemLog via `{ childState, items }`.

---

## Spawn Lifecycle with Memory Layers

```
Parent calls spawn(opts)
│
├─ Determine active layers:
│   ├─ If opts.memory is set → use spawn-local layers (parent layers do not propagate)
│   └─ If opts.memory is not set → propagate parent layers
│
├─ Child starts with empty ItemLog
│
├─ For each active memory layer (sequential, array order):
│   └─ onSpawn() → returns child state + optional items for ItemLog (or null to disable)
│
├─ Child execution runs with its ItemLog + memory layer states
│
├─ Child completes with result
│
└─ For each active memory layer (sequential, array order):
    └─ onReturn(result) → transforms result, output feeds into next layer's onReturn
```

The result transformation pipeline means layers compose naturally. A logging layer can observe the result without modifying it; a summarization layer can compress it; an extraction layer can parse structured data from it. Each layer receives the output of the previous layer's `onReturn`.

---

## Memory Layer Interaction

Memory layers are the single system for all context flow across spawn boundaries. There is no separate ItemLog strategy — layers handle everything:

- **Providing context to the child**: A layer's `onSpawn` hook can inject items into the child's initially-empty ItemLog. A layer that injects the parent's full conversation history achieves the equivalent of the old `inherit` pattern. A layer that injects a filtered subset achieves `subset`.
- **Transforming results for the parent**: A layer's `onReturn` hook receives the child's result (or the previous layer's transformed result) and returns the value the parent sees.
- **Isolation via spawn-local layers**: Setting `memory` on the spawn step replaces all parent layers with the specified set, giving complete control over what crosses the boundary in both directions.

This unified approach means there is one system to learn, one set of hooks to implement, and full composability between layers.

---

## Detached Spawn

In addition to synchronous spawning, the agent harness supports **detached spawns** — background sub-agents that run concurrently while the parent continues working.

```typescript
interface DetachedHandle<O> {
  readonly id: string;
  readonly status: DetachedStatus;    // 'running' | 'completed' | 'failed'
  readonly result: O | undefined;
  readonly error: string | undefined;
  await(timeout?: number): Promise<O>;
}
```

### Usage

```typescript
const handle = harness.detachedSpawn(subAgentStep, input, ctx);
// Parent continues immediately — handle.status === 'running'

// Later, check status or await result:
const result = await handle.await();        // blocks until done
const result = await handle.await(5_000);   // throws on timeout
```

### Lifecycle

```
Parent calls harness.detachedSpawn(step, input, ctx)
│
├─ Creates child Context with parent: ctx
├─ Starts run(step, input, childCtx) without awaiting
├─ Wraps promise in DetachedHandle
├─ Returns handle immediately
│
├─ Child runs concurrently
│   ├─ On success: handle.status → 'completed', handle.result → output
│   └─ On failure: handle.status → 'failed', handle.error → message
│
└─ Parent can:
    ├─ Poll handle.status
    ├─ Await handle.await() or handle.await(timeout)
    └─ Use channels to receive notifications on completion
```

### Context in Tools

Tools receive a `ToolExecutionContext` as their second argument, which provides `{ ctx, harness?, memory, assembledView, lastStepMeta, turnContext? }`. Note: `harness` is `undefined` when the step is executed via bare `run()` without an AgentHarness wrapper; tools that need the harness (for spawn, channels) should check for its presence. Tools that spawn sub-agents **must use `toolCtx.ctx`** (the parent context) rather than creating a new root context via `harness.createContext()`. Creating a root context breaks depth tracking, `threadId`/`resourceId` inheritance, memory layer propagation, and observability tracing. Both `harness.run()` and `harness.detachedSpawn()` create their own child contexts internally, so the tool should simply forward the parent context it receives via `toolCtx.ctx`.

---

## Parent Context Updates to Spawned Children

`spawn` creates a child context — not `fork`. `fork` branches share the parent context entirely and do not trigger `onParentUpdate`. This section applies only to `spawn` boundaries.

A spawned child does not run in complete isolation from its parent. While the child has its own ItemLog and context convergence, the parent's layers may continue to produce state changes during the child's execution. The child can receive these updates and decide how to respond.

This is opt-in per memory layer via the `onParentUpdate` hook (see `11-memory-layer-system`). The agent harness fires `onParentUpdate` on the child's layer whenever the corresponding parent layer's state changes (after `store()` on the parent side) and the child is still running. The child layer receives both the current parent state and its own current state, and decides what — if anything — to do with the update.

**The child is never forced to accept parent updates.** Returning `void` means the child ignores the update entirely. This preserves the child's autonomy while enabling reactive parent-child relationships where needed.

---

### Integration with Loop Inbox

Detached spawns pair naturally with the loop inbox channel (see `05-loop-and-until`). A common pattern:

1. LLM agent calls a `launch_agent` tool that creates a detached spawn
2. The tool registers a `.then()` callback that sends the result to the loop's inbox channel
3. The loop parks on the inbox after `until` says stop
4. When the sub-agent completes, the inbox message wakes the loop
5. The LLM sees the result as a developer message and incorporates it

---

## SubprocessAdapter Routing

Every `step.run(...)`, `spawn(...)`, and `harness.detachedSpawn(...)` dispatches through a `SubprocessAdapter`. In-process vs out-of-process is a property of the adapter, never of the step. The harness always holds one; `AgentHarness` defaults to `createInMemorySubprocessAdapter()` so zero-config callers keep their current synchronous, in-process behaviour.

### Adapter Resolution

When the interpreter dispatches a `run` or `spawn`, it resolves the active adapter as:

```
resolveStepAdapter(step, detachedOverride) =
  detachedOverride.subprocess ?? step.subprocess ?? harness.subprocess
```

Precedence:

1. **Per-call override** — the `overrides.subprocess` argument to `harness.detachedSpawn(step, input, ctx, overrides)`.
2. **Per-step override** — the `subprocess` field on `StepRun` / `StepSpawn`.
3. **Harness default** — `harness.subprocess`.

Other step kinds (`llm`, `tool`, `branch`, `fork`, `provide`, `loop`, `every`) always fall through to the harness default; they do not carry their own `subprocess` field.

### The Step Request

Every dispatch builds a `StepSubprocessRequest`:

```typescript
interface StepSubprocessRequest {
  kind: 'step';
  stepId: string;                    // registry key
  serializedInput: unknown;          // input passed to the step
  executionId: string;               // stable id (the child context id)
  overrides: {                       // applied to the child context
    threadId?: string;
    resourceId?: string;
    cwdInit?: string;
  };
  metadata?: Record<string, unknown>; // adapter-specific tags
}
```

and calls `adapter.spawn(request)`. The adapter returns a `SubprocessHandle`; for `run` the interpreter awaits settlement and unwraps `handle.metadata.result` (or rehydrates `handle.metadata.error`); for `detachedSpawn` the adapter's handle is wrapped in a `DetachedHandle` whose `.await()` polls `adapter.get()` until the status reaches a terminal value.

### Step Registry and Cross-Process Lookup

When an adapter crosses a process boundary, the child runtime must locate the step body by id. Every step builder auto-registers its result in a shared **step registry** (`@noetic-tools/core/runtime/step-registry`):

- `registerStep(step)` — called automatically by `step.run()`, `step.llm()`, `step.tool()`, `spawn()`, `provide()`, `loop()`, and other constructors whenever `step.id` is non-empty.
- `lookupStep(id)` — called by the child runtime (after importing the user's entry module) to retrieve the step definition.
- `getRegistry()` — read-only view, mainly for tests and debugging.

Registry policy is **latest registration wins**. Dispatch-and-lookup happen in the same tick, so the live entry is always the one the caller just built. Strict duplicate-id rejection is a tracked follow-up; today the registry silently overwrites on collision.

Cross-process callers share the registry by importing the same entry module. The out-of-process adapter's bootstrap reads `NOETIC_REGISTRY_ENTRY` (or equivalent adapter configuration), imports that module, and then resolves `stepId` via `lookupStep`.

### Durable Handle Manifests

Adapters that opt into durability persist a manifest per handle through the harness's `StorageAdapter`:

- `handleId` — opaque adapter identifier.
- `stepId` — the step being executed.
- `serializedInput` — input argument.
- `executionId` — parent execution context id, used to correlate with `harness.restore(executionId)`.
- Transport-specific identity (pid + `pidStarttime` for OS processes; `socketPath` for unix-socket IPC).
- Caller-supplied tags on `metadata` (e.g. `taskRole: 'planner'`, `taskId: 'T-...'`, `featureId: 'F-...'`).

On host restart the surviving handle can be rediscovered via `adapter.listLive()` and re-bound via `adapter.reattach(handleId)`. The parent context can be rehydrated by `harness.restore(executionId)` against the matching `CheckpointStore` snapshot. Full model, storage layout, and IPC semantics live in `23-durable-execution`.

### Idempotency Guidance

Durable execution means the same step body may be replayed under certain failure paths — for example, a crash that lands between step completion and the following checkpoint write. The framework cannot make arbitrary `step.run` bodies idempotent. Use stable step ids, and write step bodies whose side effects are safe to re-execute or guarded by an external idempotency key.
