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
