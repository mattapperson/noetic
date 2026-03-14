# Spawn: Child Execution with Context Boundary

> **Depends On:** `01-step-type` (Step<I,O>), `07-context-and-event-log` (Context, Message, EventLog), `11-memory-layer-system` (MemoryLayer.onSpawn/onReturn)
> **Exports:** `spawn()`, `SpawnOpts`, `ContextInStrategy`, `ContextOutStrategy`

---

## Overview

`spawn` is the most important variant. It's what makes Ralph Wiggum loops, recursive LLMs, and Slate thread weaving possible. Without it, you can't express "run this work with a different context window."

```typescript
interface SpawnOpts<I, O> {
  id: string;
  child: Step<I, O>;
  contextIn: ContextInStrategy;
  contextOut: ContextOutStrategy<O>;
  timeout?: number;
}
```

---

## The Two-Axis Design

Context strategy is split into two independent axes, each a discriminated union with explicit, configurable variants. These strategies control the **Event Log** (conversation history) that the child starts with. Memory layer state across the spawn boundary is controlled separately by each layer's `onSpawn` hook (see `11-memory-layer-system`).

### Axis 1: `contextIn` — What the child's Event Log starts with

```typescript
type ContextInStrategy =
  | { strategy: 'inherit' }                                                        // child sees parent's full Event Log
  | { strategy: 'fresh' }                                                          // child starts with empty Event Log
  | { strategy: 'subset'; select: (parentMessages: Message[], parentState: unknown) => Message[] }  // child gets filtered messages
  | { strategy: 'custom'; build: (input: unknown, parentCtx: Context) => Message[] }  // you build it explicitly
```

`subset` operates on messages from the Event Log, not a partial `Context` object. The runtime builds a proper `Context` from the filtered messages.

### How `contextIn` Interacts with Memory Layers

When `spawn()` creates a child execution, the runtime processes both axes:

1. **Event Log** is determined by `contextIn` (inherit, fresh, subset, custom).
2. **Memory layer state** is determined by each layer's `onSpawn` hook independently:
   - A layer can return `{ childState }` to provide initial state in the child.
   - A layer can return `null` to disable itself in the child.
   - A layer can inject messages into the child's initial Event Log via `{ childState, messages }`.

This separation means `contextIn: 'fresh'` gives the child an empty Event Log but memory layers still control whether their state (working memory, observations, etc.) crosses the boundary. For example, a `scope: 'resource'` working memory layer might share state across a fresh spawn because it represents user-level knowledge, while a `scope: 'execution'` layer would not.

Similarly, when the child completes, `contextOut` controls what the parent sees from the child's output, while each layer's `onReturn` hook independently merges child-side learnings back into parent state.

### Axis 2: `contextOut` — What the child's output looks like to the parent

```typescript
type ContextOutStrategy<O> =
  | { strategy: 'full' }                                           // returns O (child's output)
  | { strategy: 'summary'; model?: string; prompt?: string }       // returns string (always)
  | { strategy: 'schema'; schema: ZodType<O> }                     // returns O (parsed)
```

`spawn` with `contextOut: 'summary'` forces `O = string`. TypeScript enforces this with overloads:

```typescript
function spawn<I, O>(opts: SpawnOpts<I, O> & { contextOut: { strategy: 'full' } }): Step<I, O>;
function spawn<I>(opts: SpawnOpts<I, string> & { contextOut: { strategy: 'summary'; model?: string; prompt?: string } }): Step<I, string>;
function spawn<I, O>(opts: SpawnOpts<I, O> & { contextOut: { strategy: 'schema'; schema: ZodType<O> } }): Step<I, O>;
```

---

## Context Strategy Compatibility Matrix

All 12 combinations of `contextIn` x `contextOut` are valid for Event Log strategies. Three deserve warnings. Memory layer state transfer is orthogonal — each layer's `onSpawn`/`onReturn` hooks apply regardless of the Event Log strategy chosen here.

|               | `full`                                                                                                    | `summary`                                                                                           | `schema`                                                                                            |
|---------------|-----------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| **`inherit`** | Standard delegation. Child continues parent conversation, returns everything.                             | Child continues parent conversation, returns compressed summary. Useful for limited context budgets. | Child continues parent conversation, returns typed extraction. Good for "extract X from this conversation." |
| **`fresh`**   | Ralph Wiggum. Child starts with empty Event Log, returns full output. All state persistence across the boundary is handled by memory layers — `onSpawn` controls what crosses, `StorageAdapter` handles durability. | Slate worker. Child starts with empty Event Log, returns episodic summary. Memory layers with `scope: 'resource'` or `scope: 'global'` share state via storage. | Fresh-start extraction. Child does independent work, returns typed result. Good for independent sub-tasks. |
| **`subset`**  | Focused delegation. Child sees filtered messages, returns everything. **Warning**: returned messages may reference context the parent doesn't have. | Focused with summary. Child sees filtered context, returns compressed result. Clean re-integration.  | Focused extraction. Child sees relevant context, returns typed result. Cleanest integration pattern. |
| **`custom`**  | Custom context, full return. You build the messages, get everything back. **Warning**: "everything" may be large and unstructured. | A2A / remote agent. You craft the prompt, get a compressed response.                                | A2A with typed contract. The most structured pattern. **Recommended** for cross-agent communication. |

---

## Summary Strategy

The `summary` strategy's prompt is explicit — you tell it exactly what to compress and what to drop:

```typescript
spawn({
  id: 'worker-thread',
  child: innerReactLoop,
  contextIn: { strategy: 'fresh' },
  contextOut: {
    strategy: 'summary',
    model: 'anthropic/claude-haiku-4-5-20251001',
    prompt: 'Summarize ONLY the successful actions taken and their results. '
          + 'Exclude failed attempts, retries, and intermediate reasoning. '
          + 'Format as a bullet list of (action -> outcome) pairs.',
  },
});
```

---

## Spawn Lifecycle with Memory Layers

```
Parent calls spawn(opts)
│
├─ contextIn determines the child's initial Event Log
│
├─ For each memory layer (sequential, array order):
│   └─ onSpawn() → returns child state (or null to disable in child)
│
├─ Child execution runs with its own Event Log + memory layer states
│
├─ Child completes
│
├─ contextOut determines what the parent receives as the step output
│
└─ For each memory layer (sequential, array order):
    └─ onReturn() → merges child learnings back into parent state
```

This dual-path design means the Event Log strategy and memory layer strategy are independently configurable. A `fresh` Event Log with `inherit`-style memory layers is different from a `fresh` Event Log with all layers disabled — the first gives the child a clean conversation but carries forward knowledge; the second is a true blank slate.
