---
name: noetic-agent-builder
description: This skill provides guidance for building AI agents with the Noetic framework. It should be used when creating, modifying, or composing agent patterns using Noetic's step primitives, memory layers, tools, sub-harness (coding-agent) steps, generative UI (OpenUI), and agent harness. Triggers include mentions of "agent", "react pattern", "memory layer", "spawn", "tool", "loop", "sub-harness", "step.claudeCode", "Claude Code / Codex / opencode / pi as a step", "generative UI", "OpenUI", "openUi codec", "openUiSurface", "tool ui / render fragment", or any Noetic-specific API usage in the packages/core directory.
---

# Building Agents with Noetic

Noetic is a TypeScript agent framework where all agent patterns decompose into compositions of seven step primitives: `run`, `llm`, `tool`, `branch`, `fork`, `spawn`, and `loop`. Context boundaries are first-class concepts, and the memory layer system controls what state flows across them.

## Core Concepts

### Everything is a Step

All agent patterns compose through a single `Step<TMemory, I, O>` type. Steps are pure data (no side effects until executed). The agent harness dispatches by `step.kind`:

- **`run`** -- pure async computation
- **`llm`** -- model call with optional tools and structured output
- **`tool`** -- direct tool execution with Zod-validated I/O
- **`branch`** -- conditional routing (returns a step or null)
- **`fork`** -- parallel execution (race, all, or settle)
- **`spawn`** -- new context boundary with optional memory layers
- **`loop`** -- iteration with termination predicates
- **`claude-code` / `codex` / `opencode` / `pi`** -- sub-harness steps: delegate one turn to an external coding agent via `step.claudeCode` / `step.codex` / `step.opencode` / `step.pi` (adapter from `@noetic-tools/sub-harness-*`); see `references/api-reference.md`

### Typed Memory Access

Memory layers expose typed data and functions via `ctx.memory['layerId']`. Use the `memory()` builder with `InferMemory<>` for compile-time type safety:

```typescript
const mem = memory([workingMemory()]);
type Mem = InferMemory<typeof mem>;

step.run<Mem>({
  id: 'work',
  execute: async (input, ctx) => {
    ctx.memory['working-memory'].snapshot;  // typed
  },
});
```

### The AgentHarness

```typescript
const harness = new AgentHarness({ name: 'agent', params: {} });
const ctx = harness.createContext();
const result = await harness.run(step, input, ctx);
```

The agent harness manages execution, context creation, channels, memory lifecycle, and detached spawns. When no `callModel` is provided, `AgentHarness` auto-detects from the `OPENROUTER_API_KEY` environment variable.

The harness always holds a `SubprocessAdapter` — every `step.run`, `spawn`, and `harness.detachedSpawn` dispatches through `harness.subprocess.spawn(...)`. Zero-config harnesses use `createInMemorySubprocessAdapter()` (in-process, no overhead). Swap in `createLocalSubprocessAdapter({storage})` to run children out-of-process with durable handle manifests. Per-step and per-call `subprocess` overrides let one agent mix in-process and out-of-process dispatch — see the Key Rules section and the "Run an agent out-of-process" / "Survive a host crash" patterns in `references/composition-patterns.md`.

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

A tool may also declare `memory` (auto-generated memory layer) and `ui` (generative-UI render functions — see [Generative UI](#generative-ui-openui)). A generator `execute` (`async *execute`) yields progress events validated against the optional `event` schema.

### Memory Layers

Memory layers inject context into the LLM view (via `recall`) and persist state from responses (via `store`). Built-in layers:

- **`workingMemory()`** -- structured state updated via `updateWorkingMemory` tool call
- **`observationalMemory()`** -- buffer + distillation of observations
- **`durableTaskState()`** -- file checkpoints across fresh context boundaries
- **`staticContent()`** -- immutable instruction injection from loaded content
- **`toolMemoryLayer()`** -- auto-generated layers from tool `memory` declarations
- **`openUiSurface()`** (from `@noetic-tools/openui`) -- server-authoritative generative-UI state; see [Generative UI](#generative-ui-openui)

The `@noetic-tools/cli` package provides additional enhanced prompt layers (`promptEngineeringLayer`, `communicationStyleLayer`, `environmentContextLayer`, `toolGuidanceLayer`, `planningModeLayer`) that implement behavioral guidelines, adaptive communication, environment detection, tool preferences, and plan-mode guidance. Progressive skill disclosure is provided separately by `skillsLayer` from `@noetic-tools/code-agent`. See `packages/cli/docs/enhanced-prompt-engineering.md` for full documentation.

Recall can return a `RecallResult` object or a plain `string` (shorthand -- the agent harness wraps it in a developer message).

### Generative UI (OpenUI)

An agent can respond with a *UI* built from components you register, instead of text. This is opt-in via `@noetic-tools/openui` (depends only on memory + types; core never imports it). Three composable surfaces:

- **`step.llm({ output: openUi(library) })`** -- the model emits [OpenUI Lang](https://www.openui.com) and the step returns a `UiDocument`. `output` accepts a Zod schema OR an `OutputCodec`.
- **`openUiSurface({ library })`** -- a memory layer that makes the server the authoritative owner of UI state (durable, resumable, visible to the model). Loop with `until: ui.submitted(surface, ref)` to wait for a form submit.
- **Tool `ui` declarations** -- a tool defines `call`/`progress`/`result`/`error` render functions (built with `fragment(library)`) so its calls carry their own UI; works even without the codec installed.

`serveOpenUi(harness, { surface })` exposes it to OpenUI's React client. In a JSON workflow, an `llm` node references a codec via `output: { codec: 'openui', library }` resolved from `HydrationContext.uiLibraries`. Full API: `references/api-reference.md` → Generative UI (OpenUI).

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
| Run a real coding agent (Claude Code / Codex / opencode / pi) as a step | Sub-Harness Step | `step.claudeCode` / `step.codex` / `step.opencode` / `step.pi` |
| Agent responds with a UI (not text) | Generative UI | `step.llm({ output: openUi(library) })` + `openUiSurface()` |

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
  instructions: 'Your system prompt here.',
  tools: allTools,
  maxSteps: 25,
  memory: layers,  // auto-wraps in spawn when provided
});

const harness = new AgentHarness({
  name: 'agent',
  initialStep: agent,
  params: {},
});

// Session-scoped execution: execute() enqueues, getAgentResponse() awaits idle.
await harness.execute(userInput);
const response = await harness.getAgentResponse();

// Or drive the step tree directly (bypassing the session queue).
const ctx = harness.createContext();
const result = await harness.run(agent, userInput, ctx);
```

### Step 5: Queue Messages During Generation

The session runner accepts new messages while a turn is in flight. Use `DeliveryMode` to choose how they're delivered:

```typescript
// Default: queue and run as the next turn
await harness.execute('hello');
await harness.execute('follow-up'); // runs after 'hello' finishes

// Inject mid-turn between tool rounds (like Claude Code's inbox attachments)
await harness.execute('urgent note', { deliveryMode: 'between-rounds' });

// Interrupt: cancel in-flight turn and restart with the new message at head
await harness.execute('stop, do this instead', { deliveryMode: 'interrupt' });

// Set a harness-wide default (still overridable per-call)
const harness = new AgentHarness({ ..., defaultDeliveryMode: 'between-rounds' });
```

Observability:

- `harness.getStatus()` — `{ kind: 'idle' | 'generating' | 'aborting' }`
- `harness.getQueueSize()` — number of pending messages
- `harness.abort()` — cancel the in-flight turn; queued messages drive the next turn
- Framework events `{name}:turn_started`, `{name}:turn_completed`, `{name}:inbox_injected` expose queue delivery for UI integration

## Key Rules

1. **`Step<I, O>` is invariant** -- `Step<string, string>` is NOT assignable to `Step<unknown, unknown>`. When a framework API expects `Step` (defaulting to `Step<unknown, unknown>`), use `frameworkCast<Step>(myStep)` from `@noetic-tools/core` at the boundary. To accept any step in a custom API, use a structural type like `{ kind: Step['kind']; id: string }` instead of `Step` directly
2. **Tools receive the harness via `toolCtx.harness`** -- never pass the harness as a closure parameter to tool factories
2. **`spawn` creates context boundaries** -- memory layers decide what state crosses via `onSpawn`/`onReturn` hooks
3. **Detached spawns use `toolCtx.ctx`** -- always use the parent context, never `harness.createContext()`, to preserve depth tracking and thread/resource IDs
4. **Token/cost metadata lives on `ctx.lastStepMeta`** -- return values are pure business data
5. **`until.noToolCalls()` checks the outer loop** -- the inner tool call loop is handled by `callModel`
6. **Memory slot ordering matters** -- lower slots appear first in the LLM view. Use `Slot` constants
7. **Fork paths get cloned state** -- mutations in one path don't affect siblings
8. **SubprocessAdapter precedence is `detachedSpawn-overrides.subprocess ?? step.subprocess ?? harness.subprocess`** -- reach for a per-step override to run one specific spawn out-of-process while keeping the rest in-process, or a per-call override on `detachedSpawn` to do the same without touching the step definition
9. **Durability is opt-in and composed of three surfaces** -- `checkpointStore` (parent execution state), `subprocess` adapter durability (live-child manifests), and durable IPC (`DurableOutboundQueue`). Configure the ones you need; absent surfaces are no-ops and the harness degrades gracefully

## API Reference

For complete builder signatures, memory layer APIs, agent harness methods, and slot constants, read `references/api-reference.md`.

## Source Locations

| Concept | Source Path |
|---------|------------|
| Builders | `packages/core/src/builders/` |
| Step types | `packages/core/src/types/step.ts` |
| Tool types | `packages/core/src/types/common.ts` |
| Memory types | `packages/types/src/types/memory.ts` |
| Patterns | `packages/core/src/patterns/` |
| Memory layers | `packages/memory/src/memory/layers/` |
| Generative UI (OpenUI) | `packages/openui/src/` (codec, `openUiSurface`, `fragment`, `/server`) |
| AgentHarness | `packages/core/src/runtime/agent-harness.ts` |
| Interpreter | `packages/core/src/interpreter/` |
| Specs | `specs/` (numbered 00-16) |
| Examples | `packages/core/examples/` |
| Docs | `packages/web/content/docs/` |
