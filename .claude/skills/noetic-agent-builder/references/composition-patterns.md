# Noetic Composition Patterns

## Pattern: Basic Agent (ReAct)

The simplest agent pattern. LLM calls tools in a loop until done.

```typescript
import { react } from '@noetic-tools/core';

const agent = react({
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'You are a helpful assistant.',
  tools: [searchTool, calculatorTool],
  maxSteps: 10,
});

const harness = new AgentHarness({ name: 'basic', initialStep: agent, params: {} });
const result = await harness.execute('What is 2+2?');
```

## Pattern: Agent with Memory

Add memory layers to give the agent persistent context across turns.

```typescript
const agent = react({
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'You are a coding assistant.',
  tools: [readFile, writeFile, runTests],
  maxSteps: 25,
  memory: [
    workingMemory({ scope: 'resource' }),
    observationalMemory({ bufferThreshold: 4_000 }),
    ...toolMemoryLayer(allTools),
  ],
});
```

When `memory` is provided, `react()` auto-wraps the loop in a `spawn` boundary.

### Agent with CLI Enhanced Prompts

The `@noetic-tools/cli` package provides enhanced prompt engineering layers under `src/memory/`. Import them from the CLI memory barrel when building agents that need behavioral guidelines, adaptive communication, environment context, and tool guidance:

```typescript
import {
  promptEngineeringLayer,
  communicationStyleLayer,
  environmentContextLayer,
  toolGuidanceLayer,
  planningModeLayer,
} from '@noetic-tools/cli/src/memory/index.js';

const agent = react({
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'You are a coding assistant.',
  tools: codingTools,
  maxSteps: 25,
  memory: [
    workingMemory({ scope: 'resource' }),
    observationalMemory({ bufferThreshold: 4_000 }),
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
import { react, steering, SteeringAction } from '@noetic-tools/core';

const agent = react({
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'You are a helpful assistant.',
  tools: [searchTool, deleteTool, writeTool],
  memory: [
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

The steering layer runs at slot 90 (before all other memory layers). `Deny` blocks execution, `Guide` injects feedback for retries, `Allow` proceeds normally.

## Pattern: Sub-Agent Delegation via Tools

Tools access `toolCtx.harness` to spawn sub-agents:

```typescript
const delegateTool = tool({
  name: 'delegate',
  description: 'Run a sub-agent for a specific task',
  input: z.object({ task: z.string() }),
  output: z.string(),
  execute: async (args, toolCtx) => {
    const subAgent = react({
      model: 'anthropic/claude-sonnet-4-20250514',
      instructions: `Complete this task: ${args.task}`,
      tools: [searchTool],
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
    const subAgent = step.llm({ id: 'bg-agent', model: '...', instructions: '...' });
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
  steps: [step.llm({ id: 'llm', model: '...', tools: [launchTool] })],
  until: any(until.noToolCalls(), until.maxSteps(10)),
  inbox,
  parkTimeout: 5e3,
});
```

## Pattern: Verify-and-Retry (Ralph Wiggum)

Outer loop with verification. Each attempt gets a fresh context.

```typescript
const migrator = ralphWiggum({
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'Migrate all tests from Jest to Vitest.',
  tools: [shellTool, fileWriteTool, fileReadTool],
  verify: async (output) => {
    const result = await exec('bun test');
    return { pass: result.exitCode === 0, feedback: result.stderr };
  },
  maxIterations: 50,
  innerMaxSteps: 20,
});
```

## Pattern: Parallel Research

Multiple agents research in parallel, results merged:

```typescript
const research = fork<string, string>({
  id: 'parallel-research',
  mode: 'all',
  paths: (input) => [
    spawn({ id: 'historical', child: step.llm({ id: 'h', model: '...', instructions: 'Historical perspective' }) }),
    spawn({ id: 'technical', child: step.llm({ id: 't', model: '...', instructions: 'Technical perspective' }) }),
    spawn({ id: 'societal', child: step.llm({ id: 's', model: '...', instructions: 'Societal perspective' }) }),
  ],
  merge: (results) => results.map((r, i) => `## Perspective ${i + 1}\n\n${r}`).join('\n\n'),
});
```

## Pattern: Pipeline with Phases

Sequential processing stages using branch + loop:

```typescript
let phase = 0;
const pipeline = loop({
  id: 'pipeline',
  steps: [branch({
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

## Pattern: Tool-Owned Memory

Tools declare their own memory via `ToolMemoryDeclaration`. The agent harness materializes layers automatically:

```typescript
const todoMemory: ToolMemoryDeclaration<TodoState> = {
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
    const state = toolCtx.memory.get<TodoState>('todos') ?? { items: [] };
    state.items.push(...args.items.map(text => ({ text })));
    toolCtx.memory.set('todos', state);
    return args.items;
  },
  memory: todoMemory,
});

// Generate memory layers from tool declarations
const layers = toolMemoryLayer([writeTodosTool, listTodosTool]);
```

## Pattern: Static Instructions

Load instruction files into the LLM context:

```typescript
const instructions = staticContent({
  load: async () => {
    const text = await Bun.file('AGENTS.md').text();
    return text;
  },
  tag: 'instructions',
});
```

## Pattern: Function-Call Memory

Let the LLM update memory layer state by emitting function calls. The `store()` hook intercepts via `findFunctionCall()`. No tool schema is registered -- instruct the LLM in the system prompt.

```typescript
import { findFunctionCall, createMessage, estimateTokens, Slot } from '@noetic-tools/core';
import type { MemoryLayer } from '@noetic-tools/core';

function notesMemory(): MemoryLayer<{ notes: string[] }> {
  return {
    id: 'notes',
    name: 'Notes Memory',
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

The built-in `workingMemory()` uses this same pattern with `updateWorkingMemory`.

## Pattern: Custom Memory Layer

Build a custom memory layer for domain-specific needs:

```typescript
const entityMemory: MemoryLayer<EntityState> = {
  id: 'entity-memory',
  name: 'Entity Memory',
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

## Pattern: Layer Provides

Expose typed data and functions from a layer. Functions are automatically available as LLM tools. Use `memory()` + `InferMemory<>` for end-to-end type safety.

```typescript
import { z } from 'zod';
import {
  memory, step, loop, spawn, until, any, layerData, layerFn, Slot,
  type InferMemory, type MemoryLayer, type MemoryScope,
} from '@noetic-tools/core';

interface TaskState {
  tasks: string[];
  completed: number;
}

// Layer factory: use `satisfies` + `as const` on id to preserve literal types
function taskLayer() {
  return {
    id: 'tasks' as const,
    slot: Slot.WORKING_MEMORY,
    scope: 'execution' as const satisfies MemoryScope,
    hooks: {
      async init() {
        return { state: { tasks: [], completed: 0 } };
      },
    },
    provides: {
      pending: layerData<string[], TaskState>({
        read: (state) => state.tasks,
      }),
      complete: layerFn<{ task: string }, void, TaskState>({
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
  } satisfies MemoryLayer<TaskState>;
}

// 1. Create typed memory config
const mem = memory([taskLayer()]);
type Mem = InferMemory<typeof mem>;

// 2. Code step reads data — fully typed via TMemory generic
const checkStep = step.run<Mem>({
  id: 'check-progress',
  execute: async (_input, ctx) => {
    return `${ctx.memory.tasks.pending.length} tasks remaining`;
  },
});

// 3. LLM step gets `tasks/complete` as a tool automatically
const agent = spawn({
  id: 'task-agent',
  child: loop({
    id: 'task-loop',
    steps: [
      step.llm({ id: 'work', model: 'anthropic/claude-sonnet-4', tools: [] }),
    ],
    until: any(until.noToolCalls(), until.maxSteps(10)),
  }),
  memory: mem,
});
```

## Plan Mode with `planMemory()`

The `planMemory()` layer adds Claude Code-style plan mode to any agent. It restricts tools during planning and injects plan context during execution.

### Basic Usage

```typescript
import { planMemory, react } from '@noetic-tools/core';

const agent = react({
  model: 'anthropic/claude-sonnet-4',
  instructions: 'You are a coding assistant.',
  tools: codingTools,
  memory: [planMemory()],
});
```

When the model calls `plan/enterPlanMode`, tool calls are restricted to read-only. The model authors a PRD via `plan/updatePrd`, structures a `PlanNode` tree via `plan/setPlanTree`, then calls `plan/exitPlanMode({ action: 'execute' })` to begin execution.

### With Custom Allowed Tools

```typescript
planMemory({
  additionalAllowedTools: ['SearchDocs', 'ListIssues'],
  maxPrdLength: 1e5,
  maxTreeDepth: 3,
})
```

### CLI Integration

The CLI includes `planMemory()` by default. Users type `/plan` to enter plan mode. The agent explores with read-only tools, writes a PRD, structures a plan tree, then exits to execute.

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

## Capping LLM history with `historyWindow()`

Long sessions accumulate every assistant message and tool round-trip in `itemLog`. Without intervention, the entire transcript is replayed on every LLM call, eventually blowing the model's context window. `historyWindow` caps the trailing items projected to the LLM **without** mutating storage:

```typescript
import { historyWindow, observationalMemory, workingMemory } from '@noetic-tools/core';

const memory = [
  workingMemory(),
  observationalMemory(),
  historyWindow({ maxItems: 40 }), // default
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
import { createFileStorage, createLocalSubprocessAdapter } from '@noetic-tools/core';
// Note: the Node-specific adapter factory lives under the `node` subpath:
import { createLocalSubprocessAdapter as createLocalSubprocessAdapterNode }
  from '@noetic-tools/core/adapters/node';

// One adapter per process, reused across spawns. Persists handle manifests
// through file storage so a host crash can later reattach.
const subprocess = createLocalSubprocessAdapterNode({
  storage: createFileStorage({
    root: `${process.env.HOME}/.noetic/subprocess`,
  }),
});

// Option A — default for every spawn on this harness:
const harness = new AgentHarness({
  name: 'out-of-process',
  initialStep: agent,
  params: {},
  subprocess,
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
import {
  AgentHarness,
  createFileStorage,
  createCheckpointStore,
} from '@noetic-tools/core';
import { createLocalSubprocessAdapter } from '@noetic-tools/core/adapters/node';
import { reattachLiveChildren } from '@noetic-tools/cli';

// Three roots: subprocess manifests, checkpoint snapshots, per-project task state.
const subprocessStorage = createFileStorage({
  root: `${process.env.HOME}/.noetic/subprocess`,
});
const checkpointStorage = createFileStorage({
  root: `${process.env.HOME}/.noetic/checkpoints`,
});

const harness = new AgentHarness({
  name: 'crash-proof',
  initialStep: agent,
  params: {},
  subprocess: createLocalSubprocessAdapter({ storage: subprocessStorage }),
  checkpointStore: createCheckpointStore({ storage: checkpointStorage }),
});

// Anything the harness spawns + every turn's state is durably recorded.
const handle = harness.detachedSpawn(backgroundWorkerStep, input, parentCtx);

// ... process crashes ...

// On second boot, construct the same harness against the same roots and:
const { handles, contexts } = await reattachLiveChildren(harness);
for (const [handleId, restoredCtx] of contexts) {
  // restoredCtx has the pre-crash item log, layer state, and cwd.
  // Re-subscribe to the handle's IPC stream, replay pending ask-user
  // modals, keep going.
}
```

**Key points**:

- `reattachLiveChildren` is a thin helper — under the hood it calls `harness.subprocess.listLive()` and then `harness.restore(executionId)` per live handle. Third-party hosts can call those directly without importing `@noetic-tools/cli`.
- Subprocess manifests and checkpoint snapshots live at distinct roots (`~/.noetic/subprocess` vs `~/.noetic/checkpoints`). Override both via `NOETIC_HOME=/some/dir` if needed.
- `checkpoint()` is a no-op when `checkpointStore` is absent; `listLive()` returns the empty set when the adapter has no storage. Durability is opt-in and degrades gracefully.
- The default in-memory adapter also accepts a `storage` option for tests that want manifest round-trip behaviour without launching real OS children.

## Durable IPC server (tasks-system pattern)

Long-lived task runners (planner, implementer, agent-ci) expose their harness over a unix socket so the TUI can chat with them live. The IPC server composes a `DurableOutboundQueue` so chat survives a parent-process crash without losing or duplicating frames.

```typescript
import {
  AgentIpcServer,
  createDurableOutboundQueue,
} from '@noetic-tools/core/adapters/node';
import { createFileStorage } from '@noetic-tools/core';

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
import { createDurableOutboundQueue } from '@noetic-tools/core/adapters/node';

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

`PROTOCOL_VERSION = 2` in `@noetic-tools/core/adapters/node/agent-ipc-protocol.ts`. The v2 frames (`durable`, `durableResume`, `durableAck`) are backwards compatible — peers that don't opt in neither emit nor receive them.

## Subprocess-spawned task agent (planner / implementer)

The tasks system (`@noetic-tools/code-agent/tasks`) uses a thin wrapper over the generic "run an agent out-of-process" + "survive a host crash" patterns above. Each runner is a `harness.detachedSpawn` call against the shared tasks `SubprocessAdapter`:

```typescript
import { findLiveTaskHandle } from '@noetic-tools/code-agent/tasks';

// Launcher: refuse to start if a live runner is already attached.
const existing = await findLiveTaskHandle({
  adapter: subprocess,
  taskId,
  taskRole: 'planner',
});
if (existing !== null) {
  throw new Error(`planner already attached: ${existing.id}`);
}

// Spawn. Metadata tags are how delete-guards, pause/cancel, and live-chat
// resolve the right handle later — no sidecar files needed.
const handle = harness.detachedSpawn(plannerStep, input, ctx, {
  subprocess,
  cwdInit: taskDir,
  // metadata goes on the StepSubprocessRequest internally; the adapter
  // merges it onto handle.metadata.
});
```

Key points:

- The adapter's `listLive()` + `metadata.taskRole` / `taskId` / `featureId` tags are the single source of truth for "what is still running for this task". `findLiveTaskHandle({adapter, taskId, taskRole})` and `listLiveTaskHandles(adapter, taskId)` are the centralised queries.
- Delete-guards, pause/cancel, kanban lookups, and live-chat routing all go through those queries — no `_planner.json` / `_implementer.json` sidecars to maintain.
- The runner bootstrap (the child runtime spawned by `createLocalSubprocessAdapter`) constructs its own `AgentHarness` with task-scoped tools and drives a `react()` or `interview()` step. On success it commits in **audit → state → event** order; the adapter clears its manifest on exit automatically.
- Durability is inherited from the shared adapter's file storage at `~/.noetic/subprocess/` — no hand-rolled `pidStarttime` sidecars.

**Reusable helpers**: `verifyPidIdentity` (`agent-ci-control.ts`), `provisionWorktree` (`worktree-provision.ts`), `createShellValidator` (`hierarchy/daemon-validator.ts`), `createLlmInterviewResponder` (`llm-interview-responder.ts`).

## Pattern: Static Mode-Routing Workflow

When a workflow has several distinct modes (e.g. plan → act → verify → fix → done) and the transition between modes is deterministic, express it as a single static step tree that routes on **memory state**, not on LLM output. This keeps the graph walkable by `collectAllTools` and the eval optimizer, while retaining per-mode sub-agents with different tool sets and instructions.

Three building blocks do the work:

1. **A flow-state memory layer** carrying a `mode` field plus whatever bookkeeping the transitions need (attempt counts, findings, approval questions).
2. **Sub-agents as module-level `Step` consts** — each mode is a `spawn()` around a `loop()` that reads `mode`-specific tools / instructions via lazy `(ctx) => ...` getters.
3. **A `branch()` router** that reads `readFlowState(ctx).mode` and returns the matching sub-agent. Pair the outer `loop()` with `until.outputEquals(SENTINEL)` and a trailing `doneStep` that emits the sentinel to exit cleanly.

```typescript
// 1. Flow-state memory layer (schema omitted for brevity)
export const flowMemory: MemoryLayer<FlowState> = { /* ... */ };

export function readFlowState(ctx: Context<ContextMemory>): FlowState {
  const raw = ctx.memory[FLOW_LAYER_ID]?.state;
  return FlowStateSchema.safeParse(raw).data ?? {};
}

// 2. Per-mode sub-agents — lazy instructions + filtered tools
const planAgent: Step<ContextMemory, string, string> = spawn({
  id: 'plan-agent',
  child: loop({
    id: 'plan-loop',
    steps: [
      step.llm({
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
const doneStep: Step<ContextMemory, string, string> = step.run({
  id: 'done',
  async execute() { return DONE_SENTINEL; },
});

const workflow = loop({
  id: 'mode-loop',
  steps: [
    branch({
      id: 'mode-dispatch',
      route: (_input, ctx) => {
        const mode = readFlowState(ctx).mode ?? 'plan';
        return { plan: planAgent, act: actAgent, done: doneStep }[mode];
      },
      // Exposes all routes to collectAllTools so their unified tool pool
      // includes every sub-agent's tools, even the ones not currently reached.
      _optimizable: frameworkCast<Step<ContextMemory>[]>([planAgent, actAgent, doneStep]),
    }),
  ],
  until: until.outputEquals(DONE_SENTINEL),
});
```

Key points:

- Tools needed across modes must be supplied via `AgentHarness.tools` (since each step's `tools` is a `(ctx) => ...` getter, `collectAllTools` skips them). The per-step getter then filters `ctx.unifiedTools` down to that mode's allow-list.
- `until.outputEquals` (not `outputContains`) is the right predicate for sentinels — exact equality avoids substring collisions when sub-agent output happens to quote the marker.
- Each step that mutates flow state must call both `ctx.harness.setLayerState` (via `writeFlowState`) AND flush via `ctx.harness.storeLayers` so the next turn's rehydrate sees the post-mutation value instead of the stale pre-LLM snapshot.
- The `_optimizable` list on `branch()` tells `collectAllTools` which routes exist — without it, tools in not-currently-routed sub-agents are invisible to the unified pool and their tool calls will be rejected as unknown.

Reference implementation: `packages/code-agent/src/agents/{plan,act,verify,fix,flow-state}.ts` + the `codeAgentWorkflow` export in `packages/code-agent/src/index.ts`.

Driving `codeAgentWorkflow` headlessly (no interactive turn loop): create a context, force the starting mode, and run the workflow directly with the task as input. `@noetic-tools/code-agent` exports `writeFlowState` / `persistFlowState` / `readFlowState` for this. Passing the task as the `run` input is what delivers it to the spawned act sub-agent; `run` populates `ctx.unifiedTools` (and spawned sub-agents inherit it) so the act loop has the harness tools, and sub-agent usage rolls up onto `ctx`.

```typescript
const ctx = agent.createContext();
writeFlowState(ctx, { mode: 'act' }); // skip the plan-approval gate (auto-approved)
await persistFlowState(ctx);
const result = await agent.run(codeAgentWorkflow, task, ctx);
// ctx.tokens / ctx.cost include the spawned act/verify/fix sub-agents
```

When no `AskUserQuestion` tool is registered, the plan path also auto-approves on its own (`autoApproveStep`), so starting in `plan` mode is the alternative; forcing `act` skips planning entirely.

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
  initialStep: agent,
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
- No `step.run` in JSON — closures aren't serialisable. JSON workflows compose from `llm`, `tool`, and structural operators (`sequence`, `fork`, `loop`, `branch`, `spawn`, `provide`, `every`).
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

A sub-harness step (`step.claudeCode` / `step.codex` / `step.opencode` / `step.pi`) runs a real coding agent as a step. Compose it after a planning `llm` step in a sequence: the model decides *what* to do, the coding agent does it against the workspace.

```typescript
import { AgentHarness, step } from '@noetic-tools/core';
import { claudeCode } from '@noetic-tools/sub-harness-claude-code';

const plan = step.llm({
  id: 'plan',
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'Turn the request into a concrete, ordered implementation plan.',
});

const pipeline = step.run({
  id: 'plan-then-build',
  execute: async (input: string, ctx) => {
    const planned = await ctx.harness.run(plan, input, ctx);
    // The plan flows in as the coding agent's prompt for this turn.
    const execute = step.claudeCode({
      id: 'execute',
      harness: claudeCode({ model: 'claude-opus-4-8' }),
      prompt: `Implement this plan in the current repo:\n\n${planned}`,
      settings: { permissionMode: 'acceptEdits' },
    });
    return ctx.harness.run(execute, planned, ctx);
  },
});

const harness = new AgentHarness({ name: 'builder', initialStep: pipeline, params: {} });
await harness.execute('Add input validation to the signup endpoint.');
```

Key points:

- The coding agent runs one turn against `ctx`'s workspace (cwd/fs/shell), forwards its events as `sub_harness_event` framework events, and charges `ctx.tokens`/`ctx.cost` like any LLM step.
- `permissionMode` controls how freely the agent mutates files: `'plan'` (read-only planning), `'acceptEdits'`, `'bypassPermissions'`, or `'default'`.
- Add `output: SomeSchema` to parse the agent's final text into a typed object, exactly like `step.llm`.

## Pattern: Reuse a Coding-Agent Session Across Steps

By default each sub-harness step starts a fresh session and stops it on completion. Give two steps the same `session.reuse` key to keep one live session (workspace + conversation history + running runtime) across them — the second turn sees the first turn's history.

```typescript
const investigate = step.claudeCode({
  id: 'investigate',
  harness: claudeCode({ model: 'claude-opus-4-8' }),
  prompt: 'Find the root cause of the failing auth test. Do not change code yet.',
  settings: { permissionMode: 'plan' },
  session: { reuse: 'bugfix', onComplete: 'detach' }, // keep the session alive
});

const fix = step.claudeCode({
  id: 'fix',
  harness: claudeCode({ model: 'claude-opus-4-8' }),
  // Same `reuse` key → same session, so the agent already has its findings in context.
  prompt: 'Now apply the minimal fix for the root cause you found.',
  settings: { permissionMode: 'acceptEdits' },
  session: { reuse: 'bugfix', onComplete: 'stop' }, // last step tears it down
});
```

- `reuse` keys a session stored on the `AgentHarness`; the same key resolves to the same live session across steps.
- `onComplete`: `'detach'` parks the session for the next step, `'stop'` (default) persists and stops it, `'destroy'` discards it with no resume state. Use `'detach'` on every step but the last, `'stop'` (or `'destroy'`) on the last.

## Pattern: Coding Agent as a JSON Workflow Node

The same four agents are JSON node kinds (`claude-code` / `codex` / `opencode` / `pi`), so a plan-then-build sequence can be expressed entirely as data. The node names the agent by `kind`; the adapter instance (which carries a vendor SDK) is injected at hydration time via `HydrationContext.subHarnesses`, since adapters aren't JSON-serialisable.

```json
{
  "version": 1,
  "root": {
    "kind": "sequence",
    "id": "plan-then-build",
    "steps": [
      {
        "kind": "llm",
        "id": "plan",
        "model": "anthropic/claude-sonnet-4-20250514",
        "instructions": "Turn the request into a concrete, ordered implementation plan."
      },
      {
        "kind": "claude-code",
        "id": "execute",
        "prompt": "Implement the plan above in the current repo.",
        "settings": { "model": "claude-opus-4-8", "permissionMode": "acceptEdits" },
        "session": { "reuse": "build", "onComplete": "stop" }
      }
    ]
  }
}
```

Hydrate it with a registry built from the adapter factories:

```typescript
import { hydrateWorkflow, AgentHarness, type HydrationContext } from '@noetic-tools/core';
import { createSubHarnessRegistry } from '@noetic-tools/sub-harness';
import { claudeCode } from '@noetic-tools/sub-harness-claude-code';

const harness = new AgentHarness({ name: 'json-builder', params: {} });
const ctx = harness.createContext();

const hydrationCtx: HydrationContext = {
  tools: new Map(),
  executeStep: harness.run.bind(harness),
  subHarnesses: createSubHarnessRegistry(claudeCode()),
};

const root = hydrateWorkflow(workflowJson, hydrationCtx);
const result = await harness.run(root, 'Add input validation to the signup endpoint.', ctx);
```

Key points:

- Harness nodes carry `prompt`, `instructions?`, `settings?` (`SubHarnessSettings`), and `session?` (`SubHarnessSessionPolicy`) — the JSON mirror of the `step.claudeCode` options.
- `createSubHarnessRegistry(claudeCode(), codex(), …)` (from `@noetic-tools/sub-harness`) builds the `Map<SubHarnessKind, SubHarness>` the hydrator resolves nodes against. A node whose `kind` has no registered adapter fails hydration with `UNKNOWN_SUB_HARNESS_REFERENCE`.
- `parseAndRunWorkflow` does **not** take a sub-harness registry, so use `hydrateWorkflow` + `harness.run` (as above) when a document contains harness nodes.

## Pattern: Generative UI Interaction Loop

An agent renders a UI, the user interacts, and the loop continues until they submit. The `openUiSurface()` layer owns the state on the server; a loop predicate reads it. Requires `@noetic-tools/openui` (depends only on memory + types; core never imports it).

```typescript
import { AgentHarness, loop, memory, step, type ContextMemory } from '@noetic-tools/core';
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
  body: step.llm<ContextMemory, string, unknown>({
    id: 'render',
    model: 'claude-sonnet-5',
    tools: [validateAddress], // Query/Mutation bindings resolve against these tools
    output: openUi(library),
  }),
  until: ui.submitted(surface, 'checkout-form'),
});

const harness = new AgentHarness({
  name: 'checkout-agent',
  initialStep: checkout,
  params: {},
  memory: memory([surface]),
});
```

Key points:

- **The model emits a UI, not text.** `output: openUi(library)` folds the generated component prompt into the step and returns a `UiDocument`. Each statement streams as an `openui.node`/`openui.state`/`openui.query` framework event.
- **State lives on the server.** `openUiSurface()` reduces client interactions into `vars`/`interactions`, renders a budget-trimmed `<ui_surface>` block into the model's view each turn, and persists (thread scope) so a resumed run or reconnecting client reconstructs the exact UI.
- **The loop waits for a submit.** `ui.submitted(surface, ref)` reads the live surface via the layer instance — no new primitive. Also `ui.interacted(surface, kind?)` and `ui.toAssistant(surface)`.
- **Serve it** with `serveOpenUi(harness, { surface })` from `@noetic-tools/openui/server`, pointed at OpenUI's React client. Tool-authored UI (`ui: { call, progress, result }` on a tool, built with `fragment(library)`) works alongside — or without — the codec.
