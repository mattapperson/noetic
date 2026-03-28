---
name: noetic-agent-builder
description: This skill provides guidance for building AI agents with the Noetic framework. It should be used when creating, modifying, or composing agent patterns using Noetic's step primitives, memory layers, tools, and agent harness. Triggers include mentions of "agent", "react pattern", "memory layer", "spawn", "tool", "loop", or any Noetic-specific API usage in the packages/core directory.
---

# Building Agents with Noetic

Noetic is a TypeScript agent framework where all agent patterns decompose into compositions of seven step primitives: `run`, `llm`, `tool`, `branch`, `fork`, `spawn`, and `loop`. Context boundaries are first-class concepts, and the memory layer system controls what state flows across them.

## Core Concepts

### Everything is a Step

All agent patterns compose through a single `Step<I, O>` type. Steps are pure data (no side effects until executed). The agent harness dispatches by `step.kind`:

- **`run`** -- pure async computation
- **`llm`** -- model call with optional tools and structured output
- **`tool`** -- direct tool execution with Zod-validated I/O
- **`branch`** -- conditional routing (returns a step or null)
- **`fork`** -- parallel execution (race, all, or settle)
- **`spawn`** -- new context boundary with optional memory layers
- **`loop`** -- iteration with termination predicates

### The AgentHarness

```typescript
const harness = new InMemoryAgentHarness();
const ctx = harness.createContext();
const result = await harness.run(step, input, ctx);
```

The agent harness manages execution, context creation, channels, memory lifecycle, and detached spawns. When no `callModel` is provided, `InMemoryAgentHarness` auto-detects from the `OPENROUTER_API_KEY` environment variable.

### Tools

Tools are defined with Zod schemas for input/output validation. Inside `execute`, tools receive `ToolExecutionContext` which provides `harness`, `ctx`, and `memory` accessors:

```typescript
const myTool = tool({
  name: 'my_tool',
  description: 'Does something useful',
  input: z.object({ query: z.string() }),
  output: z.string(),
  execute: async (args, toolCtx) => {
    // toolCtx.harness -- guaranteed non-undefined AgentHarness
    // toolCtx.ctx -- parent Context
    // toolCtx.memory -- per-layer state get/set
    return `Result for: ${args.query}`;
  },
});
```

### Memory Layers

Memory layers inject context into the LLM view (via `recall`) and persist state from responses (via `store`). Built-in layers:

- **`workingMemory()`** -- structured state updated via `updateWorkingMemory` tool call
- **`observationalMemory()`** -- buffer + distillation of observations
- **`durableTaskState()`** -- file checkpoints across fresh context boundaries
- **`staticContent()`** -- immutable instruction injection from loaded content
- **`toolMemoryLayer()`** -- auto-generated layers from tool `memory` declarations

Recall can return a `RecallResult` object or a plain `string` (shorthand -- the agent harness wraps it in a developer message).

## How to Build an Agent

### Step 1: Identify the Pattern

| Goal | Pattern | Composition |
|------|---------|-------------|
| LLM with tools, stop when done | ReAct | `react()` |
| Multi-attempt with verification | Ralph Wiggum | `ralphWiggum()` |
| Parallel perspectives, merged | Parallel Research | `fork(all)` + `spawn` |
| Background sub-agents | Async Delegation | `detachedSpawn` + inbox channel |
| Sequential pipeline | Phase Router | `branch` + `loop` + `prepareNext` |
| Multi-agent task tree | Plan Execution | `compilePlan()` / `adaptivePlan()` |

For pattern-specific code examples, read `references/composition-patterns.md`.

### Step 2: Define Tools

Define tools with Zod schemas. Tools that spawn sub-agents should use `toolCtx.harness.run()` or `toolCtx.harness.detachedSpawn()` -- never capture the harness in a closure.

Tools can declare persistent memory via `ToolMemoryDeclaration`:

```typescript
memory: {
  id: 'shared-state-id',
  init: () => initialState,
  recall: (state) => stringOrNull,
}
```

Use `toolMemoryLayer(allTools)` to generate the corresponding memory layers.

### Step 3: Configure Memory

Select memory layers based on what context the agent needs:

- Static instructions? Use `staticContent({ load, tag })`
- Tool-managed state? Use `toolMemoryLayer(tools)`
- Structured progress? Use `workingMemory({ scope: 'resource' })`
- Observation compression? Use `observationalMemory({ bufferThreshold })`
- File artifacts? Use `durableTaskState({ baseDir })`

### Step 4: Compose and Execute

```typescript
const agent = react({
  model: 'anthropic/claude-sonnet-4-20250514',
  system: 'Your system prompt here.',
  tools: allTools,
  maxSteps: 25,
  memory: layers,  // auto-wraps in spawn when provided
});

const harness = new InMemoryAgentHarness();
const ctx = harness.createContext();
const result = await harness.run(agent, userInput, ctx);
```

## Key Rules

1. **`Step<I, O>` is invariant** -- `Step<string, string>` is NOT assignable to `Step<unknown, unknown>`. When a framework API expects `Step` (defaulting to `Step<unknown, unknown>`), use `frameworkCast<Step>(myStep)` from `@noetic/core` at the boundary. To accept any step in a custom API, use a structural type like `{ kind: Step['kind']; id: string }` instead of `Step` directly
2. **Tools receive the harness via `toolCtx.harness`** -- never pass the harness as a closure parameter to tool factories
2. **`spawn` creates context boundaries** -- memory layers decide what state crosses via `onSpawn`/`onReturn` hooks
3. **Detached spawns use `toolCtx.ctx`** -- always use the parent context, never `harness.createContext()`, to preserve depth tracking and thread/resource IDs
4. **Token/cost metadata lives on `ctx.lastStepMeta`** -- return values are pure business data
5. **`until.noToolCalls()` checks the outer loop** -- the inner tool call loop is handled by `callModel`
6. **Memory slot ordering matters** -- lower slots appear first in the LLM view. Use `Slot` constants
7. **Fork paths get cloned state** -- mutations in one path don't affect siblings

## API Reference

For complete builder signatures, memory layer APIs, agent harness methods, and slot constants, read `references/api-reference.md`.

## Source Locations

| Concept | Source Path |
|---------|------------|
| Builders | `packages/core/src/builders/` |
| Step types | `packages/core/src/types/step.ts` |
| Tool types | `packages/core/src/types/common.ts` |
| Memory types | `packages/core/src/types/memory.ts` |
| Patterns | `packages/core/src/patterns/` |
| Memory layers | `packages/core/src/memory/layers/` |
| AgentHarness | `packages/core/src/runtime/in-memory-agent-harness.ts` |
| Interpreter | `packages/core/src/interpreter/` |
| Specs | `specs/` (numbered 00-16) |
| Examples | `packages/core/examples/` |
| Docs | `packages/web/content/docs/` |
