---
name: noetic-agent-builder
description: This skill provides guidance for building AI agents with the Noetic framework. It should be used when creating, modifying, or composing agent patterns using Noetic's step primitives, context layers, tools, ACP coding-agent steps, generative UI (OpenUI), chat platform integration (chat-sdk.dev), and agent harness. Triggers include mentions of "agent", "react pattern", "context layer", "spawn", "tool", "loop", "acp", "agent client protocol", "step.acpAgent", "Claude Code / Codex / Gemini CLI as a step", "generative UI", "OpenUI", "openUi codec", "openUiSurface", "tool ui / render fragment", "chat-sdk", "noeticAgent", "Slack bot / Discord bot / Teams bot with Noetic", "getChannelStream", "agent plugins", "agent-plugins.org", "SKILL.md", "Agent Skills", "mcp.json", "MCP server", "agentPlugins", "loadSkill", "connection", "connections", "step.call", "step.wait", "step.verify", "verify", "verification", "OVP", "Open Verification Protocol", "profile", "defineProfile", "browser / simulator / desktop app / Slack as a connection", "trigger", "defineSource", "cron", "@noetic-tools/mcp", or any Noetic-specific API usage in the packages/core directory.
---

# Building Agents with Noetic

Noetic is a TypeScript agent framework where all agent patterns decompose into compositions of eight step primitives: `runCode`, `callModel`, `decide`, `invokeTool`, `conditional`, `inParallel`, `spawn`, and `loop`. Context boundaries are first-class concepts, and the context layer system controls what state flows across them.

## Core Concepts

### Everything is a Step

All agent patterns compose through a single `Step<TContext, I, O>` type. Steps are pure data (no side effects until executed). The agent harness dispatches by `step.kind`:

- **`runCode`** -- pure async computation
- **`callModel`** -- model call with optional tools and structured output
- **`decide`** -- typed questions (boolean, choice, score) answered with probabilities; reads the conversation but never joins it. Pass it no type arguments (annotate the `context` selector's `ctx` instead). `routeSwitch` builds a `conditional` that routes by a decision; its key form needs one case per outcome plus `uncertain`
- **`invokeTool`** -- direct tool execution with schema-validated I/O (Zod by default; any Standard Schema v1 validator accepted)
- **`conditional`** -- conditional routing (returns a step or null)
- **`inParallel`** -- parallel execution (race, all, or settle)
- **`spawn`** -- new context boundary with optional context layers
- **`loop`** -- iteration with termination predicates
- **`acp-agent`** -- delegate one turn to an external coding agent over the Agent Client Protocol via `step.acpAgent` (adapter from `@noetic-tools/acp`: `claudeCode()`, `codex()`, `gemini()`, `customAcpAgent()`); the reverse direction — serving a harness AS an ACP agent for editors like Zed — is `serveAcp()` / `toAcpAgent()`; see `references/api-reference.md`

### Typed Context Access

Context layers expose typed data and functions via `ctx.context['layerId']`. Use the `context()` builder with `InferContext<>` for compile-time type safety:

```typescript
const mem = context([scratchpad()]);
type Mem = InferContext<typeof mem>;

runCode<Mem>({
  id: 'work',
  execute: async (input, ctx) => {
    ctx.context['scratchpad'].snapshot;  // typed
  },
});
```

### The AgentHarness

```typescript
const harness = new AgentHarness({ name: 'agent', params: {} });
const ctx = harness.createContext();
const result = await harness.run(step, input, ctx);
```

The agent harness manages execution, context creation, channels, context lifecycle, and detached spawns. The LLM provider defaults to `'noetic'` (the Noetic platform, authenticated with `NOETIC_API_KEY`). For direct OpenRouter you must name it: `callModelDefaults: { provider: 'openrouter' }`, which then reads `OPENROUTER_API_KEY`. Setting `OPENROUTER_API_KEY` alone is NOT picked up.

The harness always holds a `SubprocessAdapter` — every `runCode`, `spawn`, and `harness.detachedSpawn` dispatches through `harness.subprocess.spawn(...)`. Zero-config harnesses use `createInMemorySubprocessAdapter()` from `@noetic-tools/core` (in-process, no overhead). Swap in `createLocalSubprocessAdapter({storage})` from `@noetic-tools/platform-node` to run children out-of-process with durable handle manifests. Per-step and per-call `subprocess` overrides let one agent mix in-process and out-of-process dispatch — see the Key Rules section and the "Run an agent out-of-process" / "Survive a host crash" patterns in `references/composition-patterns.md`.

### Tools

Tools are defined with schemas for input/output validation — Zod by default, though any Standard Schema v1 validator is accepted. Model-facing JSON Schema resolves through Zod, StandardJSONSchemaV1, then an explicit `inputJsonSchema` fallback. Inside `execute`, tools receive `ToolExecutionContext` which provides `harness`, `ctx`, and `context` accessors:

```typescript
const myTool = tool({
  name: 'my_tool',
  description: 'Does something useful',
  input: z.object({ query: z.string() }),
  output: z.string(),
  execute: async (args, toolCtx) => {
    // toolCtx.harness -- guaranteed non-undefined AgentHarness
    // toolCtx.ctx -- parent Context
    // toolCtx.context -- per-layer state get/set
    return `Result for: ${args.query}`;
  },
});
```

A tool may also declare `context` (auto-generated context layer) and `ui` (generative-UI render functions — see [Generative UI](#generative-ui-openui)). A generator `execute` (`async *execute`) yields progress events validated against the optional `event` schema.

### Context Layers

Context layers inject context into the LLM view (via `recall`) and persist state from responses (via `store`). Built-in layers:

- **`scratchpad()`** -- structured state updated via the `scratchpad/update` tool call
- **`observations()`** -- buffer + distillation of observations
- **`taskState()`** -- file checkpoints across fresh context boundaries
- **`instructions()`** -- immutable instruction injection from loaded content
- **`toolCalls()`** -- auto-generated layers from tool `context` declarations
- **`decisionsHistoryLayer()`** -- records `decide` answers (via the `onDecision` hook) for later steps and `callModel` views
- **`openUiSurface()`** (from `@noetic-tools/openui`) -- server-authoritative generative-UI state; see [Generative UI](#generative-ui-openui)
- **`agentPlugins()`** (from `@noetic-tools/agent-plugins`) -- an [Agent Plugins](https://agent-plugins.org) v1 client: discovers plugin packages and exposes their Agent Skills (`SKILL.md`) and MCP servers (`mcp.json`) with progressive disclosure; see `references/api-reference.md`

The `@noetic-tools/cli` package provides additional enhanced prompt layers (`promptEngineeringLayer`, `communicationStyleLayer`, `environmentContextLayer`, `toolGuidanceLayer`, `planningModeLayer`) that implement behavioral guidelines, adaptive communication, environment detection, tool preferences, and plan-mode guidance. The CLI is developed in a separate repository (`github.com/mattapperson/noetic-internal`) — import those layers from the published barrel, never from a `src/` subpath. Progressive skill disclosure is not a published built-in; the reference implementation is `packages/core/examples/deep-agent/context/skills-layer.ts`. See `references/api-reference.md` → CLI enhanced-prompt layers for signatures.

Recall can return a `RecallResult` object or a plain `string` (shorthand -- the agent harness wraps it in a developer message).

Recall output is assembled in bands so the prompt cache has a stable prefix to hold:

```
system | anchor layers | history | live layers | supersedes | tail
```

A layer's `placement` picks its band -- `'anchor'` (before history, pinned for an epoch; changes are published as a `<context_updates>` supersede at the end rather than by rewriting the prefix), `'live'` (after history, re-rendered every turn), or `'auto'` (default, chosen from observed churn). Slot orders layers within a band. This is on by default, and while it is on the runtime also sends a `cache_control: { type: 'ephemeral' }` breakpoint -- without one Claude models cache nothing however stable the prefix. `contextCache: { enabled: false }` on the harness restores the old single-block layout and drops the breakpoint with it. Declare `'live'` on any layer whose `recall()` returns state -- the runtime forces it live anyway, since a replayed render would discard what the call committed. Full behaviour and tuning: `references/api-reference.md` → Prompt-cache anchoring.

### Generative UI (OpenUI)

An agent can respond with a *UI* built from components you register, instead of text. This is opt-in via `@noetic-tools/openui` (depends only on context + types; core never imports it). Three composable surfaces:

- **`callModel({ output: openUi(library) })`** -- the model emits [OpenUI Lang](https://www.openui.com) and the step returns a `UiDocument`. `output` accepts a Standard Schema (Zod default) OR an `OutputCodec`.
- **`openUiSurface({ library })`** -- a context layer that makes the server the authoritative owner of UI state (durable, resumable, visible to the model). Loop with `until: ui.submitted(surface, ref)` to wait for a form submit.
- **Tool `ui` declarations** -- a tool defines `call`/`progress`/`result`/`error` render functions (built with `fragment(library)`) so its calls carry their own UI; works even without the codec installed.

`serveOpenUi(harness, { surface })` exposes it to OpenUI's React client. In a JSON workflow, a `callModel` node references a codec via `output: { codec: 'openui', library }` resolved from `HydrationContext.uiLibraries`. Full API: `references/api-reference.md` → Generative UI (OpenUI).

### Connections, Profiles, and Verification

A **connection** is a named, live thing the agent works with -- a browser, a simulator, a desktop app, a Slack workspace, a queue -- configured as `new AgentHarness({ connections: { browser: mcp('npx @playwright/mcp@latest') } })` (`mcp()` from `@noetic-tools/mcp`; core never imports it). Its operations reach the model as tools, gated like any tool (`policy` globs, `guarded` approval, `beforeToolCall`).

- **Profiles** (`@noetic-tools/profile-{ui,screen,browser,app,device,chat}`) are shared, versioned vocabularies. `connection('app', browser)` returns a typed handle; `step.call({ id, connection: app, op: 'ui.tap', args })` runs one operation, `step.wait({ id, connection, event, filter?, around?, timeoutMs })` waits for an event (with `around` it listens first, so the event an action causes cannot slip past).
- **Verification**: `step.verify({ id, subject, expect: [net('POST /api/orders 201').once()], never: [net('5xx')], act })` (matchers from `@noetic-tools/verify`; register `verification: verifier()` on the harness) declares claims, checks before, listens, runs `act`, and answers `pass`/`fail`/`partial`/`unknown` through OVP's `adjudicate()` -- with evidence and gaps. It never throws for `no` or `unknown`.
- **Triggers** start turns from connection events (`triggers: [{ id, connection, event, input }]`); `defineSource()` and `cron()` are in-process event sources.
- **JSON**: a document's `connections` manifest plus `call` / `wait` / `verify` nodes; `{ "$expr" }`, `{ "$secret" }`, `{ "$literal" }` values; `dynamicWorkflow({ connections })` needs an allowlist.

Full API: `references/api-reference.md` → Connections, Profiles, and Verification.

### An Array of Steps Runs in Order

Wherever Noetic takes an **array of steps** -- `loop({ steps: [...] })`, a JSON `sequence` node's `steps` -- it runs them **one at a time, in array order**. Each step starts only after the previous one finishes, and gets that step's output as its input. The array's result is the last step's output, and a step that throws stops the rest. Nothing runs concurrently unless you ask: **`inParallel` is the only exception**. Its `paths` (and a JSON `inParallel`'s `paths` or `each`) all run at the same time, each on the same input, and `merge` combines their results. Inside each path, steps still run in order.

### Emitting Items Early

A workflow's output reaches the user only when it ends, unless a step **emits items** first. Every step and JSON node takes `emitItems`; the items go into the conversation and stream through `getItemStream` at once, so a step inside a loop emits on every iteration. `true` emits the output as a final item, and a function returns text or standard items. The hook form `{ item, onStart, onDone }` emits a declared **custom item**.

### Custom Items

`customItem({ type: 'myapp:progress', event, output })` declares an item shape the way `tool()` declares a tool: `event` (optional) is what streams, `output` the final item's fields, each a Standard Schema or JSON Schema.
- **Where:** declare items on a step (`customItems`, only that step may emit them), on a `workflow()` (`customItems`), or in a JSON document's root or node `customItems` (JSON Schema).
- **How they stream:** an item streams like a model reply. Hook yields, and a generator `runCode`'s yields, are events (`custom_item_event`); a hook's return value is the final item, under the same `id`.
- **Typed results:** `new AgentHarness({ agentGraph: flow })` reads the graph's `'~customItems'` brand, typing `getItemStream`, `getFullStream` and `getAgentResponse`. Narrow a result with `isCustomItem(item, progress)` / `isCustomItemEvent(event, progress)`; comparing `item.type` alone cannot narrow.
- **Resume:** replayed steps put their items back quietly; `emitItemsOnReplay: true` on the harness streams them again.

It is all separate from the `emit` event filter on `callModel`/`decide`/`acpAgent`. See `references/api-reference.md`.

## How to Build an Agent

### Step 1: Identify the Pattern

| Goal | Pattern | Composition |
|------|---------|-------------|
| LLM with tools, stop when done | ReAct | `loop({ steps: [callModel({ ...tools })], until: any(until.noToolCalls(), until.maxSteps(n)) })` |
| Multi-attempt with verification | Ralph Wiggum | outer `loop` + `until.verified(fn)` around a fresh-context `spawn` of the inner ReAct loop |
| Parallel perspectives, merged | Parallel Research | `inParallel(all)` + `spawn` |
| Background sub-agents | Async Delegation | `detachedSpawn` + inbox channel |
| Sequential pipeline | Phase Router | `conditional` + `loop` + `prepareNext` |
| Classify input, then route by the answer | Decide and Route | `decide` + `routeSwitch` + `decisionsHistoryLayer()` |
| Multi-agent task tree | Plan Execution | hand-compose `loop` + `inParallel` + `conditional` + `spawn`, or emit a `WorkflowDocument` and run it with `parseAndRunWorkflow` |
| Deterministic state machine or counter loop with no LLM calls, as data | JSON Workflow with State | `loop` node (`"maxIterations": "infinity"`) + `compute` body + `{ "kind": "expr" }` until (JSONata, spec 33) |
| Run a real coding agent (Claude Code / Codex / Gemini CLI) as a step | ACP Agent Step | `step.acpAgent` |
| Agent responds with a UI (not text) | Generative UI | `callModel({ output: openUi(library) })` + `openUiSurface()` |
| Drive a browser / simulator / app / chat workspace | Connections | `connections: { name: mcp(...) }` + `step.call` / model tools |
| Prove an action worked, with evidence | Verify | `step.verify({ subject, expect, never, act })` + `verifier()` |
| Ask a person and wait for the answer | Wait Around | `step.wait({ event, filter, around: step.call(...) })` |
| React to external events (mentions, deploys, schedules) | Triggers | `triggers: [...]` + `defineSource()` / `cron()` |

For pattern-specific code examples, read `references/composition-patterns.md`.

### Step 2: Define Tools

Define tools with Zod schemas or any Standard Schema v1 validator. Non-Zod validators should implement StandardJSONSchemaV1 or provide `inputJsonSchema`. Tools that spawn sub-agents should use `toolCtx.harness.run()` or `toolCtx.harness.detachedSpawn()` -- never capture the harness in a closure.

Tools can declare persistent state via `ToolContextDeclaration`:

```typescript
context: {
  id: 'shared-state-id',
  init: () => initialState,
  recall: (state) => stringOrNull,
}
```

Use `toolCalls(allTools)` to generate the corresponding context layers.

### Step 3: Configure Context

Select context layers based on what context the agent needs:

- Static instructions? Use `instructions({ load, tag })`
- Tool-managed state? Use `toolCalls(tools)`
- Structured progress? Use `scratchpad({ scope: 'resource' })`
- Observation compression? Use `observations({ bufferThreshold })`
- File artifacts? Use `taskState({ baseDir })`

### Step 4: Compose and Execute

```typescript
// A ReAct agent is a loop of model calls, spawned with its context layers.
const agent = spawn({
  id: 'agent',
  child: loop({
    id: 'react-loop',
    steps: [
      callModel({
        id: 'work',
        model: 'anthropic/claude-sonnet-4-20250514',
        instructions: 'Your system prompt here.',
        tools: allTools,
      }),
    ],
    until: any(until.noToolCalls(), until.maxSteps(25)),
  }),
  context: layers,
});

const harness = new AgentHarness({
  name: 'agent',
  agentGraph: agent,
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

// Steer the running turn before its next model call (like Claude Code's inbox attachments)
await harness.execute('urgent note', { deliveryMode: 'between-rounds' });

// Steer as soon as the model finishes the item it is writing (like Responses `response.steer`)
await harness.execute('use staging, not prod', { deliveryMode: 'next-item' });

// Interrupt: cancel in-flight turn and restart with the new message at head
await harness.execute('stop, do this instead', { deliveryMode: 'interrupt' });

// Set a harness-wide default (still overridable per-call)
const harness = new AgentHarness({ ..., defaultDeliveryMode: 'between-rounds' });
```

Observability:

- `harness.getStatus()` — `{ kind: 'idle' | 'generating' | 'draining' | 'aborting' }`; `getStatus({ executionId })` for a `run()` execution
- `harness.getQueueSize()` — number of pending messages
- `harness.abort()` — cancel the in-flight turn; queued messages drive the next turn. `abort({ drainMs })` (or `cancel(ctx, { drainMs })`) stops gracefully: nothing new starts, in-flight model calls get `drainMs` to finish and be charged, then it cancels and resolves with a `DrainReport` (`finished` calls carry their `cost` and `usage`)
- Framework events `{name}:turn_started`, `{name}:turn_completed`, `{name}:inbox_injected` expose queue delivery for UI integration

## Key Rules

1. **`Step<I, O>` is invariant** -- `Step<string, string>` is NOT assignable to `Step<unknown, unknown>`. When a framework API expects `Step` (defaulting to `Step<unknown, unknown>`), use `frameworkCast<Step>(myStep)` from `@noetic-tools/core/unstable` at the boundary. To accept any step in a custom API, use a structural type like `{ kind: Step['kind']; id: string }` instead of `Step` directly
2. **Tools receive the harness via `toolCtx.harness`** -- never pass the harness as a closure parameter to tool factories
2. **`spawn` creates context boundaries** -- context layers decide what state crosses via `onSpawn`/`onReturn` hooks; `onParentUpdate` lets a running child react to the parent's later writes
3. **Detached spawns use `toolCtx.ctx`** -- always use the parent context, never `harness.createContext()`, to preserve depth tracking and thread/resource IDs
4. **Token/cost metadata lives on `ctx.lastStepMeta`** -- return values are pure business data
5. **`until.noToolCalls()` checks the outer loop** -- the inner tool call loop is handled by `callModel`
6. **Placement picks the band, slot orders within it** -- anchored layer output renders before history, live output after it; lower slots come first inside a band. Use `Slot` constants, and set `placement: 'live'` on any layer whose `recall()` mutates state
7. **Parallel paths get cloned state** -- mutations in one `inParallel` path don't affect siblings
8. **SubprocessAdapter precedence is `detachedSpawn-overrides.subprocess ?? step.subprocess ?? harness.subprocess`** -- reach for a per-step override to run one specific spawn out-of-process while keeping the rest in-process, or a per-call override on `detachedSpawn` to do the same without touching the step definition
9. **An array of steps runs in order; only `inParallel` paths run concurrently** -- `loop` steps and JSON `sequence` steps each wait for the one before and take its output. `inParallel` paths all start together on the same input
10. **Durability follows storage and is composed of three surfaces** -- the checkpoint store + step ledger (parent execution state and finished steps; defaults to a store over `environment.storage.adapter`; the harness option `durability: false` turns it off), `subprocess` adapter durability (live-child manifests), and durable IPC (`DurableOutboundQueue`). With a storage adapter, a run cut off on one harness resumes on a new harness over the same storage: `harness.restore(id)` then re-run the same step on the same input, and finished steps and model-loop rounds replay for free. Storage is the only record: a failed run retried on the same context rebuilds from storage, and sessions read their history from storage every turn. Replayed work keeps its `cost` but reports `billedCost: 0`. Absent surfaces are no-ops and the harness degrades gracefully

## API Reference

For complete builder signatures, context layer APIs, agent harness methods, and slot constants, read `references/api-reference.md`.

## Source Locations

| Concept | Source Path |
|---------|------------|
| Builders | `packages/core/src/builders/` |
| Step types | `packages/types/src/types/step.ts` |
| Tool types | `packages/types/src/types/tool.ts` |
| Context layer types | `packages/types/src/types/context-layer.ts` |
| JSON workflow runtime | `packages/core/src/builders/dynamic-workflow.ts`, `packages/core/src/builders/workflow-hydrator.ts` |
| JSON workflow expressions (JSONata) | `packages/core/src/expression/` |
| Context layers | `packages/context/src/context/layers/` |
| Prompt-cache anchoring | `packages/context/src/context/cache-anchoring.ts`, `packages/core/src/interpreter/context-assembly.ts` |
| Generative UI (OpenUI) | `packages/openui/src/` (codec, `openUiSurface`, `fragment`, `/server`) |
| Connections (registry, gates, pools, triggers, sources) | `packages/core/src/connections/`, `packages/types/src/types/connection.ts` |
| Connection steps | `packages/core/src/interpreter/execute-call.ts`, `execute-wait.ts`, `execute-verify.ts`, `packages/core/src/builders/verify-builder.ts` |
| MCP bridge | `packages/mcp/src/` (`mcp()`, `./conformance`) |
| Profiles | `packages/types/src/types/profile.ts` (`defineProfile`, `defineExtension`), `packages/profile-*/src/` |
| Verification (OVP) | `packages/types/src/verify/`, `packages/verify/src/` |
| AgentHarness | `packages/core/src/harness/agent-harness.ts` |
| Interpreter | `packages/core/src/interpreter/` |
| Specs | `specs/` (numbered 00-37; connections 35, profiles 36, verification 37) |
| Examples | `packages/core/examples/` |
| Docs | `packages/web/content/docs/` |
