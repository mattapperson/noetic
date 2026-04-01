# Noetic Composition Patterns

## Pattern: Basic Agent (ReAct)

The simplest agent pattern. LLM calls tools in a loop until done.

```typescript
import { react } from '@noetic/core';

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

## Pattern: Agent with Steering

Use the steering layer to enforce policies on tool usage and model output.

```typescript
import { react, steering, SteeringAction } from '@noetic/core';

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
import { findFunctionCall, createMessage, estimateTokens, Slot } from '@noetic/core';
import type { MemoryLayer } from '@noetic/core';

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
} from '@noetic/core';

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
