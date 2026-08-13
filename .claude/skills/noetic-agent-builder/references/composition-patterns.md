# Noetic Composition Patterns

## Pattern: Basic Agent (ReAct)

The simplest agent pattern. LLM calls tools in a loop until done.

```typescript
import { AgentHarness, any, callModel, loop, until } from '@noetic-tools/core';

const agent = loop({
  id: 'react',
  steps: [
    callModel({
      id: 'assistant',
      model: 'anthropic/claude-sonnet-4-20250514',
      instructions: 'You are a helpful assistant.',
      tools: [searchTool, calculatorTool],
    }),
  ],
  until: any(until.noToolCalls(), until.maxSteps(10)),
});

const harness = new AgentHarness({ name: 'basic', agentGraph: agent, params: {} });
const result = await harness.execute('What is 2+2?');
```

## Pattern: Agent with Context Layers

Add context layers to give the agent persistent context across turns. Wrap the loop in a `spawn` boundary that carries the layers.

```typescript
const agent = spawn({
  id: 'coding-agent',
  child: loop({
    id: 'react',
    steps: [
      callModel({
        id: 'assistant',
        model: 'anthropic/claude-sonnet-4-20250514',
        instructions: 'You are a coding assistant.',
        tools: [readFile, writeFile, runTests],
      }),
    ],
    until: any(until.noToolCalls(), until.maxSteps(25)),
  }),
  context: [
    scratchpad({ scope: 'resource' }),
    observations({ bufferThreshold: 4_000 }),
    ...toolCalls(allTools),
  ],
});
```

### Agent with CLI Enhanced Prompts

The `@noetic-tools/cli` package provides enhanced prompt engineering layers. **The CLI is developed in a separate repository** (`github.com/mattapperson/noetic-internal`), so there is no `packages/cli` in this workspace — import from the published barrel, never from a `src/` subpath:

```typescript
import {
  promptEngineeringLayer,
  communicationStyleLayer,
  environmentContextLayer,
  toolGuidanceLayer,
  planningModeLayer,
} from '@noetic-tools/cli';

const agent = spawn({
  id: 'coding-agent',
  child: loop({
    id: 'react',
    steps: [
      callModel({
        id: 'assistant',
        model: 'anthropic/claude-sonnet-4-20250514',
        instructions: 'You are a coding assistant.',
        tools: codingTools,
      }),
    ],
    until: any(until.noToolCalls(), until.maxSteps(25)),
  }),
  context: [
    scratchpad({ scope: 'resource' }),
    observations({ bufferThreshold: 4_000 }),
    promptEngineeringLayer(),
    communicationStyleLayer(),
    environmentContextLayer({ config: agentConfig, shell: shellAdapter }),
    toolGuidanceLayer({ tools: codingTools, mode: 'normal' }),
    // Only include in planning mode:
    // planningModeLayer({ availableTools: codingTools, currentMode: 'planning' }),
  ],
});
```

All CLI enhanced layers use `execution` scope and `Slot.PROCEDURAL` (250). The harness factory in `@noetic-tools/cli` assembles them automatically; manual composition is only needed when building custom agents outside the CLI harness.

## Pattern: Agent with Steering

Use the steering layer to enforce policies on tool usage and model output.

```typescript
import { any, callModel, loop, spawn, steering, SteeringAction, until } from '@noetic-tools/core';

const agent = spawn({
  id: 'steered-agent',
  child: loop({
    id: 'react',
    steps: [
      callModel({
        id: 'assistant',
        model: 'anthropic/claude-sonnet-4-20250514',
        instructions: 'You are a helpful assistant.',
        tools: [searchTool, deleteTool, writeTool],
      }),
    ],
    until: any(until.noToolCalls(), until.maxSteps(25)),
  }),
  context: [
    steering({
      rules: [
        {
          id: 'deny-delete',
          appliesTo: ['beforeToolCall'],
          predicate: (params) => {
            if ('toolName' in params && params.toolName === 'delete') {
              return { action: SteeringAction.Deny, guidance: 'Deletion is not allowed' };
            }
            return { action: SteeringAction.Allow };
          },
        },
        {
          id: 'guide-search',
          appliesTo: ['beforeToolCall'],
          predicate: (params) => {
            if ('toolName' in params && params.toolName === 'search') {
              return { action: SteeringAction.Guide, guidance: 'Prefer specific queries' };
            }
            return { action: SteeringAction.Allow };
          },
        },
      ],
    }),
  ],
});
```

The steering layer runs at slot 90 (before all other context layers). `Deny` blocks execution, `Guide` injects feedback for retries, `Allow` proceeds normally.

## Pattern: Sub-Agent Delegation via Tools

Tools access `toolCtx.harness` to spawn sub-agents:

```typescript
const delegateTool = tool({
  name: 'delegate',
  description: 'Run a sub-agent for a specific task',
  input: z.object({ task: z.string() }),
  output: z.string(),
  execute: async (args, toolCtx) => {
    const subAgent = loop({
      id: 'sub-agent-loop',
      steps: [
        callModel({
          id: 'sub-agent-llm',
          model: 'anthropic/claude-sonnet-4-20250514',
          instructions: `Complete this task: ${args.task}`,
          tools: [searchTool],
        }),
      ],
      until: any(until.noToolCalls(), until.maxSteps(15)),
    });
    const spawnStep = spawn({ id: 'sub-agent', child: subAgent });
    return toolCtx.harness.run(spawnStep, args.task, toolCtx.ctx);
  },
});
```

## Pattern: Async Background Agents

Launch sub-agents in the background, receive results via inbox channel:

```typescript
const inbox = channel('agent-inbox', { schema: z.string(), mode: 'queue' });
const handles = new Map<string, DetachedHandle<string>>();

const launchTool = tool({
  name: 'launch_agent',
  description: 'Launch a background sub-agent',
  input: z.object({ task: z.string() }),
  output: z.object({ agentId: z.string() }),
  execute: async (args, toolCtx) => {
    const subAgent = callModel({ id: 'bg-agent', model: '...', instructions: '...' });
    const handle = toolCtx.harness.detachedSpawn(subAgent, args.task, toolCtx.ctx);
    handles.set(handle.id, handle);

    // Notify inbox when done
    void handle.await().then((result) => {
      toolCtx.harness.send(inbox, `[Done] ${result}`, toolCtx.ctx);
    });

    return { agentId: handle.id };
  },
});

const agent = loop({
  id: 'orchestrator',
  steps: [callModel({ id: 'llm', model: '...', tools: [launchTool] })],
  until: any(until.noToolCalls(), until.maxSteps(10)),
  inbox,
  parkTimeout: 5e3,
});
```

## Pattern: Verify-and-Retry (Ralph Wiggum)

Outer loop with verification wrapping an inner ReAct loop. Spawning the attempt gives each iteration a fresh context.

```typescript
const attempt = spawn({
  id: 'attempt',
  child: loop({
    id: 'attempt-loop',
    steps: [
      callModel({
        id: 'migrate',
        model: 'anthropic/claude-sonnet-4-20250514',
        instructions: 'Migrate all tests from Jest to Vitest.',
        tools: [shellTool, fileWriteTool, fileReadTool],
      }),
    ],
    until: any(until.noToolCalls(), until.maxSteps(20)),
  }),
});

const migrator = loop({
  id: 'verify-retry',
  steps: [attempt],
  until: any(
    until.verified(async (output) => {
      const result = await exec('bun test');
      return { pass: result.exitCode === 0, feedback: result.stderr };
    }),
    until.maxSteps(50),
  ),
});
```

## Pattern: Parallel Research

Multiple agents research in parallel, results merged:

```typescript
const research = inParallel<string, string>({
  id: 'parallel-research',
  mode: 'all',
  paths: (input) => [
    spawn({ id: 'historical', child: callModel({ id: 'h', model: '...', instructions: 'Historical perspective' }) }),
    spawn({ id: 'technical', child: callModel({ id: 't', model: '...', instructions: 'Technical perspective' }) }),
    spawn({ id: 'societal', child: callModel({ id: 's', model: '...', instructions: 'Societal perspective' }) }),
  ],
  merge: (results) => results.map((r, i) => `## Perspective ${i + 1}\n\n${r}`).join('\n\n'),
});
```

## Pattern: Pipeline with Phases

Sequential processing stages using conditional + loop:

```typescript
let phase = 0;
const pipeline = loop({
  id: 'pipeline',
  steps: [conditional({
    id: 'router',
    route: () => {
      if (phase === 0) return normalizeStep;
      if (phase === 1) return analyzeStep;
      if (phase === 2) return formatStep;
      return null;
    },
  })],
  until: until.maxSteps(3),
  prepareNext: (output) => { phase++; return output; },
});
```

## Pattern: Tool-Owned State

Tools declare their own persistent state via `ToolContextDeclaration`. The agent harness materializes layers automatically:

```typescript
const todoContext: ToolContextDeclaration<TodoState> = {
  id: 'todos',  // shared across tools with the same id
  init: () => ({ items: [] }),
  recall: (state) => {
    if (!state.items.length) return null;
    return `<todos>\n${state.items.map(i => `- ${i.text}`).join('\n')}\n</todos>`;
  },
};

const writeTodosTool = tool({
  name: 'write_todos',
  input: z.object({ items: z.array(z.string()) }),
  output: z.array(z.string()),
  execute: async (args, toolCtx) => {
    const state = toolCtx.context.get<TodoState>('todos') ?? { items: [] };
    state.items.push(...args.items.map(text => ({ text })));
    toolCtx.context.set('todos', state);
    return args.items;
  },
  context: todoContext,
});

// Generate context layers from tool declarations
const layers = toolCalls([writeTodosTool, listTodosTool]);
```

## Pattern: Static Instructions

Load instruction files into the LLM context:

```typescript
const instructionsLayer = instructions({
  load: async () => {
    const text = await Bun.file('AGENTS.md').text();
    return text;
  },
  tag: 'instructions',
});
```

## Pattern: Function-Call Layer State

Let the LLM update context layer state by emitting function calls. The `store()` hook intercepts via `findFunctionCall()`. No tool schema is registered -- instruct the LLM in the system prompt.

```typescript
import { findFunctionCall, createMessage, estimateTokens, Slot } from '@noetic-tools/core';
import type { ContextLayer } from '@noetic-tools/core';

function notesLayer(): ContextLayer<{ notes: string[] }> {
  return {
    id: 'notes',
    name: 'Notes Layer',
    slot: Slot.PROCEDURAL,
    scope: 'thread',
    budget: { min: 100, max: 500 },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<{ notes: string[] }>('state');
        return { state: saved ?? { notes: [] } };
      },
      async recall({ state }) {
        if (!state.notes.length) return null;
        const content = `<notes>\n${state.notes.join('\n')}\n</notes>`;
        return {
          items: [createMessage(content, 'developer')],
          tokenCount: estimateTokens(content),
        };
      },
      async store({ newItems, state, storage }) {
        const args = findFunctionCall(newItems, 'saveNote');
        if (!args) return;
        const updated = { notes: [...state.notes, args.text as string] };
        await storage.set('state', updated);
        return { state: updated };
      },
    },
  };
}

// System prompt must instruct the LLM:
// "Call saveNote({ text: '...' }) to remember important observations."
```

The built-in `scratchpad()` uses this same pattern with its `scratchpad/update` function.

## Pattern: Custom Context Layer

Build a custom context layer for domain-specific needs:

```typescript
const entityLayer: ContextLayer<EntityState> = {
  id: 'entity-layer',
  name: 'Entity Layer',
  slot: Slot.ENTITY,
  scope: 'resource',
  hooks: {
    async init({ storage }) {
      const saved = await storage.get<EntityState>('state');
      return { state: saved ?? { entities: [] } };
    },
    async recall({ state }) {
      if (!state.entities.length) return null;
      return `<entities>\n${JSON.stringify(state.entities)}\n</entities>`;
    },
    async store({ newItems, state }) {
      // Extract entities from LLM response using findFunctionCall
      const args = findFunctionCall(newItems, 'updateEntities');
      if (!args) return;
      return { state: { ...state, entities: [...state.entities, ...args.entities] } };
    },
    async onSpawn({ parentState }) {
      return { childState: structuredClone(parentState) };
    },
  },
};
```

## Pattern: Anchoring a Large Layer for the Prompt Cache

A layer whose output is big and mostly stable belongs in the anchor band, ahead of history, where the prompt cache can hold it. Add `renderDelta` so the occasional change costs a few tokens at the end of the view instead of a full republish plus a re-billed window.

```typescript
const catalogLayer: ContextLayer<CatalogState> = {
  id: 'catalog',
  slot: Slot.RAG,
  scope: 'thread',
  placement: 'anchor',
  hooks: {
    async init({ storage }) {
      return { state: (await storage.get<CatalogState>('state')) ?? { entries: {} } };
    },
    async recall({ state }) {
      const body = Object.entries(state.entries)
        .map(([name, text]) => `## ${name}\n${text}`)
        .join('\n\n');
      return body ? `<catalog>\n${body}\n</catalog>` : null;
    },
    // Only the entries that moved, not the whole catalog.
    async renderDelta({ prevState, state }) {
      const changed = Object.keys(state?.entries ?? {}).filter(
        (name) => prevState?.entries[name] !== state?.entries[name],
      );
      if (changed.length === 0) return null;  // null falls back to a full republish
      return changed.map((name) => `## ${name}\n${state?.entries[name]}`).join('\n\n');
    },
  },
};
```

The counterpart: a layer whose `recall()` commits something must be `'live'`, because a pinned replay would throw that commit away. The runtime forces this anyway — declaring it just makes the intent readable.

```typescript
const feedbackLayer: ContextLayer<FeedbackState> = {
  id: 'feedback',
  slot: Slot.STEERING,
  scope: 'execution',
  placement: 'live',
  hooks: {
    async init() { return { state: { pending: [] } }; },
    async recall({ state }) {
      if (!state.pending.length) return null;
      // Drains as it renders — non-idempotent, so it can never be replayed.
      return { items: state.pending.map((t) => createMessage(t, 'developer')),
               tokenCount: estimateTokens(state.pending.join('\n')),
               state: { pending: [] } };
    },
  },
};
```

## Pattern: Layer Provides

Expose typed data and functions from a layer. Functions are automatically available as LLM tools. Use `context()` + `InferContext<>` for end-to-end type safety.

```typescript
import { z } from 'zod';
import {
  context, step, loop, spawn, until, any, layerData, layerFunction, Slot,
  type InferContext, type ContextLayer, type ContextScope,
} from '@noetic-tools/core';

interface TaskState {
  tasks: string[];
  completed: number;
}

// Layer factory: use `satisfies` + `as const` on id to preserve literal types
function taskLayer() {
  return {
    id: 'tasks' as const,
    slot: Slot.SCRATCHPAD,
    scope: 'execution' as const satisfies ContextScope,
    hooks: {
      async init() {
        return { state: { tasks: [], completed: 0 } };
      },
    },
    provides: {
      pending: layerData<string[], TaskState>({
        read: (state) => state.tasks,
      }),
      complete: layerFunction<{ task: string }, void, TaskState>({
        description: 'Mark a task as complete.',
        input: z.object({ task: z.string() }),
        output: z.void(),
        execute: async (args, state) => ({
          result: undefined,
          state: {
            tasks: state.tasks.filter((t) => t !== args.task),
            completed: state.completed + 1,
          },
        }),
      }),
    },
  } satisfies ContextLayer<TaskState>;
}

// 1. Create typed context config
const mem = context([taskLayer()]);
type Mem = InferContext<typeof mem>;

// 2. Code step reads data — fully typed via the TContext generic
const checkStep = runCode<Mem>({
  id: 'check-progress',
  execute: async (_input, ctx) => {
    return `${ctx.context.tasks.pending.length} tasks remaining`;
  },
});

// 3. The callModel step gets `tasks/complete` as a tool automatically
const agent = spawn({
  id: 'task-agent',
  child: loop({
    id: 'task-loop',
    steps: [
      callModel({ id: 'work', model: 'anthropic/claude-sonnet-4', tools: [] }),
    ],
    until: any(until.noToolCalls(), until.maxSteps(10)),
  }),
  context: mem,
});
```

## Plan Mode with `plan()`

The `plan()` layer adds Claude Code-style plan mode to any agent. It restricts tools during planning and injects plan context during execution.

### Basic Usage

```typescript
import { any, callModel, loop, plan, spawn, until } from '@noetic-tools/core';

const assistant = callModel({
  id: 'assistant',
  model: 'anthropic/claude-sonnet-4',
  instructions: 'You are a coding assistant.',
  tools: codingTools,
});

const agent = spawn({
  id: 'planning-agent',
  child: loop({
    id: 'agent-loop',
    steps: [assistant],
    until: any(until.noToolCalls(), until.maxSteps(25)),
  }),
  context: [plan()],
});
```

When the model calls `plan/enterPlanMode`, tool calls are restricted to read-only. The model authors a PRD via `plan/updatePrd`, structures the plan as a JSON `WorkflowDocument` via `plan/setPlanTree({ document })`, factors detailed mechanics into named workflows via `plan/setWorkflow({ name, document })` (referenced from the tree with `{ kind: 'subflow', ref: '<name>' }` nodes), then calls `plan/exitPlanMode({ action: 'execute' })`. Exit rejects dangling subflow refs and workflow cycles before any approval callback runs.

### With Custom Allowed Tools

```typescript
plan({
  additionalAllowedTools: ['SearchDocs', 'ListIssues'],
  maxPrdLength: 1e5,
  maxDepth: 3,
  allowedNodeKinds: ['sequence', 'callModel', 'invokeTool', 'subflow'],
})
```

### Executing an Approved Plan

The plan format IS the JSON workflow runtime format, so the host runs it directly:

```typescript
const onExit = async (state) => {
  const approved = await ui.requestApproval(state.prd, state.planTree, state.workflows);
  if (approved) {
    void parseAndRunWorkflow({
      json: state.planTree,
      workflows: new Map(Object.entries(state.workflows)),
      harness, ctx, tools,
    });
  }
  return { approved };
};
```

### CLI Integration

The CLI includes `plan()` by default. Users type `/plan` to enter plan mode. The agent explores with read-only tools, writes a PRD, structures the plan document plus named workflows, then exits to execute.

---

## Pattern: Custom Reminder Triggers

The CLI's `reminderLayer()` emits `<system-reminder>`-wrapped developer messages based on a registry of triggers. You can contribute triggers from a plugin via the `reminderTriggers` hook.

### Registering a trigger from a plugin

```typescript
import type { NoeticPlugin } from '@noetic-tools/cli';
import type { ReminderTrigger } from '@noetic-tools/cli';

const myPlugin: NoeticPlugin = {
  name: 'my-plugin',
  version: '1.0.0',
  reminderTriggers: async () => [
    {
      id: 'long-bash-streak',
      minTurnsBetweenReminders: 6,
      timing: 'recall',
      shouldFire: ({ state }) => {
        const bashCount = state.toolUsageCounts.get('Bash') ?? 0;
        if (bashCount < 20) {
          return null;
        }
        return 'You have called Bash 20+ times this session. Consider whether a dedicated tool would be cleaner.';
      },
    } satisfies ReminderTrigger,
  ],
};
```

### Reading sibling layer state from a trigger

Use `ctx.readLayerState<T>(layerId)` to inspect another layer's state before deciding to fire:

```typescript
{
  id: 'agent-md-reminder',
  minTurnsBetweenReminders: 15,
  timing: 'recall',
  shouldFire: ({ ctx, state }) => {
    if (state.assistantTurnCount < 15) return null;
    const agentMd = ctx.readLayerState<{ sources: ReadonlyArray<unknown> }>('agent-md');
    if (agentMd === undefined || agentMd.sources.length === 0) return null;
    return 'Remember: AGENT.md rules still apply — re-check the loaded instructions before continuing.';
  },
}
```

### Choosing timing

- `'recall'` — the reminder appears in the next turn's assembled context. Best for periodic nags.
- `'immediate'` — the reminder is injected via `onItemAppend` alongside an incoming tool output. Best for error-recovery reminders that need to appear before the next model call.

### Throttling

`minTurnsBetweenReminders` uses the layer's `assistantTurnCount` clock. The trigger won't fire again until that many assistant turns have elapsed since its last firing. Use `Number.POSITIVE_INFINITY` for "fire once per session."

## Capping LLM history with `history()`

Long sessions accumulate every assistant message and tool round-trip in `itemLog`. Without intervention, the entire transcript is replayed on every LLM call, eventually blowing the model's context window. `history` caps the trailing items projected to the LLM **without** mutating storage:

```typescript
import { history, observations, scratchpad } from '@noetic-tools/core';

const layers = [
  scratchpad(),
  observations(),
  history({ maxItems: 40 }), // default
];
```

Properties of the projection:

- **Storage isolation.** `itemLog`, `accumulatedItems`, session JSON, `getAgentResponse`, and any UI reading the log all see the full transcript. Only the value handed to `assembleView` is narrowed.
- **Minimum-exchange guarantee.** The projected window always contains at least one user `message` and one assistant `message`. If a small `maxItems` value would otherwise truncate one role away, the layer expands backward until both are present (the cap may be temporarily exceeded).
- **Pair integrity.** After slicing, `stripUnresolvedToolCalls` runs on the window so no `function_call` is ever sent to the LLM without its matching `function_call_output` (or vice-versa) — the API rejects unpaired tool items.
- **Mid-round flow uncapped.** Within a single `callModel` invocation's tool loop, that round's own `function_call` / `function_call_output` items keep accumulating in the wire payload. The cap fires at turn boundaries, not mid-call.
- **Opt-in for the CLI.** When `AgentConfig.history.maxItems` is unset, the layer is not installed and history is uncapped. Set the value via `noetic.config.ts` or the `/config` editor's Memory tab to enable capping.

## Run an agent out-of-process

Swap the adapter to run a specific spawn in its own OS child process. The step composition is unchanged; only the dispatch path differs.

```typescript
// The Node-only adapter factories live in `@noetic-tools/platform-node`;
// `@noetic-tools/core` ships only contracts and in-memory adapters.
import { createFileStorage, createLocalSubprocessAdapter } from '@noetic-tools/platform-node';

// One adapter per process, reused across spawns. Persists handle manifests
// through file storage so a host crash can later reattach.
const subprocess = createLocalSubprocessAdapter({
  storage: createFileStorage({
    root: `${process.env.HOME}/.noetic/subprocess`,
  }),
});

// Option A — default for every spawn on this harness:
const harness = new AgentHarness({
  name: 'out-of-process',
  agentGraph: agent,
  params: {},
  environment: { subprocess },
});

// Option B — per-step override (only this spawn goes out-of-process):
const researchStep = spawn({
  id: 'research',
  child: researchAgent,
  subprocess,
});

// Option C — per-call override on detachedSpawn:
const handle = harness.detachedSpawn(agent, input, ctx, {
  subprocess,
  cwdInit: '/tmp/workspace',
});
```

**When to use**: the child needs a clean crash boundary from the parent (its own pid, its own memory pressure, its own LLM client), or will run long enough that a parent restart during its lifetime is plausible.

**What the adapter does**: spawns `bun run <step-bootstrap>` with `NOETIC_REGISTRY_ENTRY` pointing at the parent's entry module, passes the serialised input via stdin, and captures `handle.metadata.result` / `handle.metadata.error` from stdout. The child re-imports the same step registry and looks up the step by id — which is why step builders auto-register at construction.

## Survive a host crash

When the host that launched a long-running child can crash, configure durable storage so the child survives independently and the parent context can be rebuilt on restart.

```typescript
import { AgentHarness, createCheckpointStore } from '@noetic-tools/core';
import { createFileStorage, createLocalSubprocessAdapter } from '@noetic-tools/platform-node';

// Three roots: subprocess manifests, checkpoint snapshots, per-project task state.
const subprocessStorage = createFileStorage({
  root: `${process.env.HOME}/.noetic/subprocess`,
});
const checkpointStorage = createFileStorage({
  root: `${process.env.HOME}/.noetic/checkpoints`,
});

const harness = new AgentHarness({
  name: 'crash-proof',
  agentGraph: agent,
  params: {},
  environment: {
    subprocess: createLocalSubprocessAdapter({ storage: subprocessStorage }),
    storage: {
      checkpointStore: createCheckpointStore({ storage: checkpointStorage }),
    },
  },
});

// Anything the harness spawns + every turn's state is durably recorded.
const handle = harness.detachedSpawn(backgroundWorkerStep, input, parentCtx);

// ... process crashes ...

// On second boot, construct the same harness against the same roots, then
// rediscover the live children and rebuild a context per execution:
for (const live of await harness.subprocess.listLive()) {
  const executionId = live.metadata?.executionId;
  if (executionId === undefined) {
    continue;
  }
  const restoredCtx = await harness.restore(executionId);
  if (restoredCtx === null) {
    continue; // no checkpoint snapshot for this execution
  }
  // restoredCtx has the pre-crash item log, layer state, and cwd.
  // Re-subscribe to the handle's IPC stream, replay pending ask-user
  // modals, keep going.
}
```

**Key points**:

- Recovery is two primitives: `harness.subprocess.listLive()` rediscovers children from the persisted manifest, and `harness.restore(executionId)` rebuilds each context from its checkpoint (returning `null` when no snapshot exists). The Noetic CLI ships a `reattachLiveChildren` convenience wrapper over exactly this loop, but it lives in a separate repository — any host can call the two primitives directly.
- Subprocess manifests and checkpoint snapshots live at distinct roots (`~/.noetic/subprocess` vs `~/.noetic/checkpoints`). Override both via `NOETIC_HOME=/some/dir` if needed.
- `checkpoint()` is a no-op when `environment.storage.checkpointStore` is absent; `listLive()` returns the empty set when the adapter has no storage. Durability is opt-in and degrades gracefully.
- The default in-memory adapter also accepts a `storage` option for tests that want manifest round-trip behaviour without launching real OS children.

## Durable IPC server (tasks-system pattern)

Long-lived task runners (planner, implementer, agent-ci) expose their harness over a unix socket so the TUI can chat with them live. The IPC server composes a `DurableOutboundQueue` so chat survives a parent-process crash without losing or duplicating frames.

```typescript
import {
  AgentIpcServer,
  createDurableOutboundQueue,
  createFileStorage,
} from '@noetic-tools/platform-node';

const storage = createFileStorage({
  root: `${process.env.HOME}/.noetic/subprocess`,
});

// The server composes the queue automatically when you hand it a storage.
// Outbound frames are wrapped in `{type: 'durable', seq, frame}` envelopes.
// On client reconnect, the server handles `durableResume { ackedThrough }` by
// replaying queue.frameRange(ackedThrough + 1). On `durableAck { throughSeq }`
// it calls queue.ackUpTo(throughSeq) to compact.
const server = new AgentIpcServer({
  socketPath,
  chatHistoryStore,
  taskLogger,
  askUserService,
  storage,  // <-- opt in to durable outbound
});

await server.start();
```

**When to compose `DurableOutboundQueue` manually** (without `AgentIpcServer`): any framed byte stream — WebSocket, TCP, plain JSONL file — can use the same pattern.

```typescript
import { createDurableOutboundQueue } from '@noetic-tools/platform-node';

const queue = await createDurableOutboundQueue({ storage, socketPath });

// Producer (server):
const encoded = JSON.stringify(originalFrame);
const { seq } = await queue.append(encoded);
socket.write(encodeFrame({ type: 'durable', seq, frame: originalFrame }));

// On client durableAck { throughSeq }:
await queue.ackUpTo(ack.throughSeq);

// On client durableResume { ackedThrough } (after server hello):
for (const entry of await queue.frameRange(resume.ackedThrough + 1)) {
  socket.write(encodeFrame({
    type: 'durable',
    seq: entry.seq,
    frame: JSON.parse(entry.frame),
  }));
}
```

`PROTOCOL_VERSION = 2` in `packages/platform-node/src/agent-ipc-protocol.ts`. The v2 frames (`durable`, `durableResume`, `durableAck`) are backwards compatible — peers that don't opt in neither emit nor receive them.

## Subprocess-spawned task agent (planner / implementer)

A task runner (planner, implementer, reviewer…) is a thin composition of the generic "run an agent out-of-process" + "survive a host crash" patterns above: one `harness.detachedSpawn` call against a shared, durably-stored `SubprocessAdapter`, with the adapter's own manifest as the source of truth for "what is still running".

```typescript
// One shared adapter per host, backed by file storage so the manifest
// survives a restart.
const subprocess = createLocalSubprocessAdapter({
  storage: createFileStorage({ root: `${process.env.HOME}/.noetic/subprocess` }),
});

// Launcher: refuse to start if a live runner already exists for this task.
// The adapter's manifest is queried directly — no sidecar files.
const live = await subprocess.listLive();
const existing = live.find((h) => h.metadata?.executionId === plannerExecutionId);
if (existing !== undefined) {
  throw new Error(`planner already attached: ${existing.id}`);
}

const handle = harness.detachedSpawn(plannerStep, input, ctx, {
  subprocess,
  cwdInit: taskDir,
});
```

Key points:

- Derive the runner's `executionId` deterministically from the task identity (e.g. `` `${taskId}:planner` ``) so `listLive()` alone answers "is this runner already attached?". `SubprocessHandleMetadata` carries `executionId`, `result`, and `error`; the same id is what `harness.restore(executionId)` rebuilds a context from.
- Delete-guards, pause/cancel, kanban lookups, and live-chat routing can all go through that one query — no `_planner.json` / `_implementer.json` sidecars to maintain.
- The runner bootstrap (the child runtime spawned by `createLocalSubprocessAdapter`) constructs its own `AgentHarness` with task-scoped tools and drives a ReAct-style loop or interview step. The adapter clears its manifest entry on exit automatically.
- Durability is inherited from the shared adapter's file storage at `~/.noetic/subprocess/` — no hand-rolled `pidStarttime` sidecars.
- The Noetic CLI's tasks system is the reference consumer of this pattern (worktree provisioning, pid-identity checks, LLM interview responders), but it is developed in a separate repository and is not importable from this workspace.

## Pattern: Static Mode-Routing Workflow

When a workflow has several distinct modes (e.g. plan → act → verify → fix → done) and the transition between modes is deterministic, express it as a single static step tree that routes on **context-layer state**, not on LLM output. This keeps the graph walkable by `collectAllTools` and the eval optimizer, while retaining per-mode sub-agents with different tool sets and instructions.

Three building blocks do the work:

1. **A flow-state context layer** carrying a `mode` field plus whatever bookkeeping the transitions need (attempt counts, findings, approval questions).
2. **Sub-agents as module-level `Step` consts** — each mode is a `spawn()` around a `loop()` that reads `mode`-specific tools / instructions via lazy `(ctx) => ...` getters.
3. **A `conditional()` router** that reads `readFlowState(ctx).mode` and returns the matching sub-agent. Pair the outer `loop()` with `until.outputEquals(SENTINEL)` and a trailing `doneStep` that emits the sentinel to exit cleanly.

```typescript
// 1. Flow-state context layer (schema omitted for brevity)
export const flowLayer: ContextLayer<FlowState> = { /* ... */ };

export function readFlowState(ctx: Context<ContextData>): FlowState {
  const raw = ctx.context[FLOW_LAYER_ID]?.state;
  return FlowStateSchema.safeParse(raw).data ?? {};
}

// 2. Per-mode sub-agents — lazy instructions + filtered tools
const planAgent: Step<ContextData, string, string> = spawn({
  id: 'plan-agent',
  child: loop({
    id: 'plan-loop',
    steps: [
      callModel({
        id: 'plan-chat',
        model: (ctx) => readParam(ctx, 'model', '', isString),
        instructions: (ctx) => PLAN_INSTRUCTIONS,
        tools: (ctx) =>
          (ctx.unifiedTools ?? []).filter((t) => PLAN_MODE_TOOL_NAMES.has(t.name)),
      }),
      postPlanCheckStep, // inspects output, flips flow-state mode
    ],
    until: until.noToolCalls(),
  }),
});

// 3. Router + sentinel-driven exit
const DONE_SENTINEL = '<<<workflow-done>>>';
const doneStep: Step<ContextData, string, string> = runCode({
  id: 'done',
  async execute() { return DONE_SENTINEL; },
});

const workflow = loop({
  id: 'mode-loop',
  steps: [
    conditional({
      id: 'mode-dispatch',
      route: (_input, ctx) => {
        const mode = readFlowState(ctx).mode ?? 'plan';
        return { plan: planAgent, act: actAgent, done: doneStep }[mode];
      },
      // Exposes all routes to collectAllTools so their unified tool pool
      // includes every sub-agent's tools, even the ones not currently reached.
      _optimizable: frameworkCast<Step<ContextData>[]>([planAgent, actAgent, doneStep]),
    }),
  ],
  until: until.outputEquals(DONE_SENTINEL),
});
```

Key points:

- Tools needed across modes must be supplied via `AgentHarness.tools` (since each step's `tools` is a `(ctx) => ...` getter, `collectAllTools` skips them). The per-step getter then filters `ctx.unifiedTools` down to that mode's allow-list.
- `until.outputEquals` (not `outputContains`) is the right predicate for sentinels — exact equality avoids substring collisions when sub-agent output happens to quote the marker.
- Each step that mutates flow state must call both `ctx.harness.setLayerState` (via `writeFlowState`) AND flush via `ctx.harness.storeLayers` so the next turn's rehydrate sees the post-mutation value instead of the stale pre-LLM snapshot.
- The `_optimizable` list on `conditional()` tells `collectAllTools` which routes exist — without it, tools in not-currently-routed sub-agents are invisible to the unified pool and their tool calls will be rejected as unknown.

Driving the workflow headlessly (no interactive turn loop): create a context, force the starting mode by writing the flow layer's state, and run the workflow directly with the task as input. Pair the pattern-local `readFlowState` above with `writeFlowState` (sets layer state) and `persistFlowState` (flushes via `harness.storeLayers`). Passing the task as the `run` input is what delivers it to the spawned sub-agent; `run` populates `ctx.unifiedTools` (and spawned sub-agents inherit it) so the mode loop has the harness tools, and sub-agent usage rolls up onto `ctx`.

```typescript
const ctx = harness.createContext();
writeFlowState(ctx, { mode: 'act' }); // skip the plan-approval gate
await persistFlowState(ctx);
const result = await harness.run(workflow, task, ctx);
// ctx.tokens / ctx.cost include the spawned per-mode sub-agents
```

When no `AskUserQuestion` tool is registered, give the plan path its own auto-approval step so it can't stall waiting on a user; forcing `act` skips planning entirely. The Noetic CLI's code agent is the reference consumer of this pattern (plan / act / verify / fix modes over a shared flow-state layer), but it is developed in a separate repository and is not importable from this workspace.

## Pattern: Dynamic Workflow (LLM-Generated JSON)

An LLM generates a complete workflow as JSON, which the harness hydrates and executes in the same session.

```typescript
import { dynamicWorkflow, AgentHarness } from '@noetic-tools/core';

const agent = dynamicWorkflow({
  model: 'openai/gpt-4o',
  tools: [searchTool, calcTool],
  instructions: 'Create an efficient multi-step workflow',
  maxDepth: 5,
  maxRevisions: 3,
});

const harness = new AgentHarness({
  name: 'dynamic-planner',
  agentGraph: agent,
  params: {},
});

await harness.execute('Research quantum computing and summarize');
const response = await harness.getAgentResponse();
```

Key points:

- The planner LLM receives instructions describing the JSON workflow schema and available tools, then generates a `WorkflowDocument` as structured output.
- The document is validated against `WorkflowDocumentSchema`, hydrated into a native `Step` tree via `hydrateWorkflow`, then executed with the same interpreter as hand-written compositions.
- `maxRevisions` controls retry attempts when the LLM produces invalid JSON. Each retry includes the previous validation error as feedback.
- `maxDepth` caps workflow tree depth to prevent runaway nesting.
- Inline closures don't serialise — a `runCode` node carries its body as a code string dispatched through a subprocess adapter. JSON workflows compose from `callModel`, `invokeTool`, `runCode`, and structural node kinds (`sequence`, `inParallel`, `loop`, `conditional`, `spawn`, `withContext`, `schedule`, `subflow`).
- Tools are referenced by name in JSON and resolved from the `HydrationContext.tools` registry at hydration time.
- A published JSON Schema (draft 2020-12) is generated from `WorkflowDocumentSchema` and shipped at the `@noetic-tools/core/schema` export subpath (`$id`: `https://noetic.tools/schema/noetic-workflow.schema.json`). Reference it via a `$schema` key in hand-written or LLM-generated documents for editor autocompletion and validation. **The `*.schema.json` files are generated — never hand-edit them. Whenever you change `WorkflowDocumentSchema` (or any node/predicate variant) in `packages/core/src/schemas/workflow.ts`, you MUST run `bun run gen:schema` in the same commit** to regenerate both the package artifact and the hosted web copy (`packages/web/public/schema/...`); a drift-gate test fails CI otherwise. See `.claude/rules/sync-spec-code-docs.md` Requirement 6.

A complete runnable example — an Opus planner generating a "mixture-of-agents" workflow (four models in parallel → an Opus judge that synthesises the answer) and executing it — lives at `packages/core/examples/dynamic-judge-workflow.ts`, with the canonical document committed at `packages/core/examples/multi-model-judge.workflow.json`.

For running pre-built JSON workflows without an LLM planner step:

```typescript
import { parseAndRunWorkflow } from '@noetic-tools/core';

const result = await parseAndRunWorkflow({
  json: workflowJsonFromDatabase,
  harness,
  ctx: harness.createContext(),
  tools: [searchTool, calcTool],
});
```

## Pattern: Plan with an LLM, Execute with a Coding Agent

`step.acpAgent` runs a real coding agent as a step, over the Agent Client Protocol. Compose it after a planning `callModel` step: the model decides *what* to do, the coding agent does it against the workspace.

```typescript
import { AgentHarness, callModel, runCode, step } from '@noetic-tools/core';
import { claudeCode } from '@noetic-tools/acp';

const plan = callModel({
  id: 'plan',
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'Turn the request into a concrete, ordered implementation plan.',
});

const pipeline = runCode({
  id: 'plan-then-build',
  execute: async (input: string, ctx) => {
    const planned = await ctx.harness.run(plan, input, ctx);
    // The plan flows in as the coding agent's prompt for this turn.
    const execute = step.acpAgent({
      id: 'execute',
      agent: claudeCode(),
      prompt: `Implement this plan in the current repo:\n\n${planned}`,
      permissions: { allow: [{ kind: 'read' }, { kind: 'edit' }] },
    });
    return ctx.harness.run(execute, planned, ctx);
  },
});

const harness = new AgentHarness({ name: 'builder', agentGraph: pipeline, params: {} });
await harness.execute('Add input validation to the signup endpoint.');
```

Key points:

- The agent's file reads/writes and shell commands are served by `ctx.fs` and `ctx.shell`, so its workspace access is sandboxed and audited like a first-party step. It forwards its protocol notifications as `acp_event` framework events and charges `ctx.tokens`/`ctx.cost` like any `callModel` step.
- `permissions` governs what the agent may do. The default is **deny**: a step that grants nothing lets the agent do nothing but talk. Grant by ACP tool `kind` (`read`, `edit`, `execute`, …) or `title`.
- Add `output: SomeSchema` to parse the agent's final text into a typed object, exactly like `callModel`.
- A fresh session is seeded with the conversation so far, so the agent understands what earlier steps established.

## Pattern: Reuse a Coding-Agent Session Across Steps

By default each ACP step opens a connection and closes it on completion. Give two steps the same `session.reuse` key to keep one live connection + session across them — the second turn sees the first turn's history on the agent side.

```typescript
const investigate = step.acpAgent({
  id: 'investigate',
  agent: claudeCode(),
  prompt: 'Find the root cause of the failing auth test. Do not change code yet.',
  permissions: { allow: [{ kind: 'read' }] },       // read-only investigation
  session: { reuse: 'bugfix' },                     // 'keep' is the default for a reused session
});

const fix = step.acpAgent({
  id: 'fix',
  agent: claudeCode(),
  // Same `reuse` key → same session, so the agent already has its findings in context.
  prompt: 'Now apply the minimal fix for the root cause you found.',
  permissions: { allow: [{ kind: 'read' }, { kind: 'edit' }] },
  session: { reuse: 'bugfix', onComplete: 'close' }, // last step tears it down
});
```

- `reuse` keys a connection + session stored on the `AgentHarness`; the same key resolves to the same live session across steps.
- `onComplete`: `'keep'` (the default for a reused session) leaves it live; `'close'` ends the connection and stops the agent. Use `'close'` on the last step.
- `session.load` resumes an ACP session id from an earlier run, for agents that advertise `loadSession`.

## Pattern: Coding Agent as a JSON Workflow Node

`acp-agent` is a JSON node kind, so a plan-then-build sequence can be expressed entirely as data. The node names the agent by a registry key; the adapter instance is injected at hydration time via `HydrationContext.acpAgents`, since adapters aren't JSON-serialisable.

```json
{
  "version": 1,
  "root": {
    "kind": "sequence",
    "id": "plan-then-build",
    "steps": [
      {
        "kind": "callModel",
        "id": "plan",
        "model": "anthropic/claude-sonnet-4-20250514",
        "instructions": "Turn the request into a concrete, ordered implementation plan."
      },
      {
        "kind": "acp-agent",
        "id": "execute",
        "agent": "claude-code",
        "prompt": "Implement the plan above in the current repo.",
        "permissions": { "default": "deny", "allow": [{ "kind": "read" }, { "kind": "edit" }] },
        "session": { "reuse": "build", "onComplete": "close" }
      }
    ]
  }
}
```

Hydrate it with a registry built from the agent presets:

```typescript
import { hydrateWorkflow, AgentHarness, type HydrationContext } from '@noetic-tools/core';
import { claudeCode, codex, createAcpAgentRegistry } from '@noetic-tools/acp';

const harness = new AgentHarness({ name: 'json-builder', params: {} });
const ctx = harness.createContext();

const hydrationCtx: HydrationContext = {
  tools: new Map(),
  executeStep: harness.run.bind(harness),
  acpAgents: createAcpAgentRegistry(claudeCode(), codex()),
};

const root = hydrateWorkflow(workflowJson, hydrationCtx);
const result = await harness.run(root, 'Add input validation to the signup endpoint.', ctx);
```

Key points:

- An `acp-agent` node carries `agent`, `prompt`, and optional `cwd` / `mode` / `model` / `mcpServers` / `permissions` / `clientCapabilities` / `session` — the JSON mirror of the `step.acpAgent` options.
- `createAcpAgentRegistry(claudeCode(), codex(), …)` builds the `Map<string, AcpAgent>` the hydrator resolves nodes against. The keys are the adapters' `agentId`s, an **open** set — supporting a new agent needs another entry, not a schema change. An unregistered `agent` fails hydration with `UNKNOWN_ACP_AGENT_REFERENCE`.
- `parseAndRunWorkflow` does **not** take an agent registry, so use `hydrateWorkflow` + `harness.run` (as above) when a document contains `acp-agent` nodes.

## Pattern: Generative UI Interaction Loop

An agent renders a UI, the user interacts, and the loop continues until they submit. The `openUiSurface()` layer owns the state on the server; a loop predicate reads it. Requires `@noetic-tools/openui` (depends only on `@noetic-tools/context` + `@noetic-tools/types`; core never imports it).

```typescript
import { AgentHarness, callModel, context, type ContextData, loop } from '@noetic-tools/core';
import { createLibrary, defineComponent, openUi, openUiSurface, ui } from '@noetic-tools/openui';
import { z } from 'zod';

const library = createLibrary([
  defineComponent({ name: 'Form', props: z.object({ id: z.string(), children: z.array(z.unknown()) }) }),
  defineComponent({ name: 'Field', props: z.object({ label: z.string(), bind: z.string() }) }),
  defineComponent({ name: 'Submit', props: z.object({ label: z.string() }) }),
]);

const surface = openUiSurface({ library });

const checkout = loop({
  id: 'checkout',
  steps: [
    callModel<ContextData, string, unknown>({
      id: 'render',
      model: 'claude-sonnet-5',
      tools: [validateAddress], // Query/Mutation bindings resolve against these tools
      output: openUi(library),
    }),
  ],
  until: ui.submitted(surface, 'checkout-form'),
});

const harness = new AgentHarness({
  name: 'checkout-agent',
  agentGraph: checkout,
  params: {},
  contextLayers: [surface],
});
```

Key points:

- **The model emits a UI, not text.** `output: openUi(library)` folds the generated component prompt into the step and returns a `UiDocument`. Each statement streams as an `openui.node`/`openui.state`/`openui.query` framework event.
- **State lives on the server.** `openUiSurface()` reduces client interactions into `vars`/`interactions`, renders a budget-trimmed `<ui_surface>` block into the model's view each turn, and persists (thread scope) so a resumed run or reconnecting client reconstructs the exact UI.
- **The loop waits for a submit.** `ui.submitted(surface, ref)` reads the live surface via the layer instance — no new primitive. Also `ui.interacted(surface, kind?)` and `ui.toAssistant(surface)`.
- **Serve it** with `serveOpenUi(harness, { surface })` from `@noetic-tools/openui/server`, pointed at OpenUI's React client. Tool-authored UI (`ui: { call, progress, result }` on a tool, built with `fragment(library)`) works alongside — or without — the codec.

## Pattern: Multi-Platform Chat Bot (chat-sdk.dev)

Run a harness as the brain of a Slack/Teams/Discord/Telegram bot with `@noetic-tools/chat-sdk`. One handler wires seeding, execution, and streaming; chat tools with approval gates ride external channels.

```typescript
import { Chat } from 'chat';
import { AgentHarness } from '@noetic-tools/core';
import {
  noeticAgent, chatTools, createChatHistoryStore,
  approvalRequests, resolveApproval,
} from '@noetic-tools/chat-sdk';

const chat = new Chat({ adapters: [slack()], state: redis() });

const harness = new AgentHarness({
  name: 'support-bot',
  agentGraph: agentLoop,
  params: {},
  tools: await chatTools({ chat }), // write tools keep the vendor's approval gate
});

chat.onSubscribedMessage(noeticAgent({
  harness,
  historyLimit: 20,
  history: createChatHistoryStore({ get: (k) => redis.get(k), set: (k, v) => redis.set(k, v) }),
  deliveryMode: 'between-rounds',
}));
```

- **Streaming is turn-scoped.** Each incoming message becomes one harness turn; the translated stream terminates at `turn_completed`, which is what resolves `thread.post()`. Tool calls render as `task_update` cards on Slack/Linear and degrade elsewhere.
- **History survives restarts** with a store: threads seed from persisted items instead of refetching the platform, and completed model items pump from `getItemStream` into the store.
- **Approvals flow through external channels.** A gated tool parks; ONE integration observer per harness watches `harness.getChannelStream(approvalRequests, APPROVAL_SCOPE)` (a never-closed lifetime scope — no execution id needed), routes the card by `request.threadId`, and the click calls `resolveApproval({harness, decision})`. Rejections surface to the model as tool errors; Chat SDK's write tools stay gated by default.
