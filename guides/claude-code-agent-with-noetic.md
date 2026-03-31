# Building a Claude Code-Like Agent with Noetic

This guide walks through how to recreate the core architecture of Claude Code — its 5 specialized agent types, plan/act mode, coordinator pattern, and sub-agent delegation — using Noetic's step primitives, memory layers, and patterns.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [The Single Harness](#the-single-harness)
- [Tool Sets Per Agent Type](#tool-sets-per-agent-type)
- [Branching Between Agent Types](#branching-between-agent-types)
- [Plan Mode vs Act Mode](#plan-mode-vs-act-mode)
- [The Full Loop](#the-full-loop)
- [Async Sub-Agents](#async-sub-agents)
- [Inter-Agent Communication](#inter-agent-communication)
- [Context Compaction](#context-compaction)
- [Doom Loop Detection](#doom-loop-detection)
- [Putting It All Together](#putting-it-all-together)
- [What Doesn't Map Directly](#what-doesnt-map-directly)

---

## Architecture Overview

Claude Code's architecture has five key subsystems:

1. **QueryEngine** — the main LLM loop (stream tokens, process tool calls, repeat)
2. **Tool System** — ~40 tools with permission-gated execution
3. **Coordinator** — multi-agent orchestration (research → synthesize → implement → verify)
4. **Plan/Act Mode** — permission gating that blocks write tools in plan mode
5. **Compaction** — context management when conversations grow long

Noetic maps these to composable primitives:

| Claude Code Subsystem | Noetic Primitive | Controls |
|---|---|---|
| QueryEngine (LLM + tool loop) | `loop([step.llm(...)], until.noToolCalls())` | Execution flow |
| Tool System (per-agent tool sets) | `tools` param on `step.llm()` | What the model **can call** — different per agent type |
| Agent type switching | `branch()` inside the loop | Which `step.llm()` (with which tools) runs each iteration |
| Plan/Act Mode | `branch()` over mode state | Which agent types are available |
| Memory layers | `memory` on `AgentHarness` | What memory layers are available to steps |
| Compaction | `observationalMemory()` layer | What the model **sees in context** |

**Key principle**: Each agent type is a different `step.llm()` with its own `tools` array. The `tools` param is the hard capability boundary — it defines what function calls the LLM can make. Memory layers are a separate concern that controls prompt context (what the model sees), not capabilities (what the model can do).

Everything runs through a single `AgentHarness` instance.

---

## The Single Harness

All execution — the coordinator loop, every branched agent step, and any spawned sub-agents — shares one `AgentHarness`. The harness provides the LLM client, channel store, tracing, and storage.

```typescript
import { AgentHarness } from '@noetic/core';

const harness = new AgentHarness({
  name: 'claude-code-agent',
  initialStep: mainLoop,       // a loop() — see below
  memory: memoryLayers,        // memory layers for context management
  params: {},
  llm: { provider: 'openrouter' },
});

const result = await harness.execute(userInput);
```

The `AgentHarness` **is** the agent. The `initialStep` is the loop that defines what the agent does. `memory` provides memory layers (compaction, steering, working memory) to every execution. Calling `execute()` creates a fresh context with those layers and runs the step.

Events (tool calls, model responses) flow through the harness in real-time — there's no isolation boundary between the main loop and the UI. Reserve `spawn` for sub-agents that need isolated contexts.

---

## Tool Sets Per Agent Type

Claude Code has 5 built-in agent types. The primary difference between them is their **tool set** — each `step.llm()` gets a different `tools` array:

| Agent Type | Model | Tool Set | Notes |
|---|---|---|---|
| **Explore** | `haiku` | `[glob, grep, read, bash_readonly]` | Fast, cheap, read-only |
| **Plan** | parent model | `[glob, grep, read, bash_readonly]` | Same tools as explore, different system prompt |
| **Verification** | parent model | `[glob, grep, read, bash_readonly, bash_tmp]` | Read-only + can write scripts to `/tmp` |
| **General** | parent model | `[glob, grep, read, write, edit, bash]` | Full capability — only type that writes project files |
| **Guide** | `haiku` | `[glob, grep, read, web_fetch]` | Documentation lookup |

Define each as a pre-built `step.llm()`:

```typescript
import { step } from '@noetic/core';

const readOnlyTools = createCodebaseTools(rootDir);          // glob, grep, read, bash-readonly
const fullTools = [...readOnlyTools, ...createWriteTools(rootDir)]; // + write, edit, bash
const verifyTools = [...readOnlyTools, ...createTmpWriteTools()];  // + bash limited to /tmp
const guideTools = [...readOnlyTools, ...createWebTools()];        // + web_fetch

// Each agent type = a step.llm with its own tools and system prompt
const exploreStep = step.llm({
  id: 'explore',
  model: 'anthropic/claude-haiku-4',
  system: 'You are a fast codebase exploration agent. Read files, search code, report findings.',
  tools: readOnlyTools,
});

const planStep = step.llm({
  id: 'plan',
  model: 'anthropic/claude-sonnet-4-20250514',
  system: 'You are a software architect. Explore the code, then output a step-by-step implementation plan.',
  tools: readOnlyTools,
});

const verifyStep = step.llm({
  id: 'verify',
  model: 'anthropic/claude-sonnet-4-20250514',
  system: [
    'You are an adversarial verification agent. Run builds, tests, linters.',
    'Try boundary values. End with VERDICT: PASS, VERDICT: FAIL, or VERDICT: NEEDS_REVISION.',
  ].join('\n'),
  tools: verifyTools,
});

const generalStep = step.llm({
  id: 'general',
  model: 'anthropic/claude-sonnet-4-20250514',
  system: 'Complete the task fully. Do not gold-plate, but do not leave it half-done.',
  tools: fullTools,
});

const guideStep = step.llm({
  id: 'guide',
  model: 'anthropic/claude-haiku-4',
  system: 'You answer questions about Claude Code, the Agent SDK, and the Claude API.',
  tools: guideTools,
});
```

No factories, no resolvers, no dynamic step construction. Each agent type is a static `step.llm()` with its tools baked in.

---

## Branching Between Agent Types

The core pattern: the loop body contains a `branch` that routes each iteration to the appropriate `step.llm()` based on state. The model's output from one iteration feeds into the routing decision for the next.

```typescript
import { branch } from '@noetic/core';

const agentRouter = branch({
  id: 'agent-type-router',
  route: (input, ctx) => {
    // Read which agent type to use from working memory or input
    const agentType = ctx.state.nextAgentType ?? 'explore';

    const routes: Record<string, Step> = {
      explore: exploreStep,
      plan: planStep,
      verification: verifyStep,
      general: generalStep,
      'claude-code-guide': guideStep,
    };

    return routes[agentType] ?? exploreStep;
  },
});
```

Each iteration of the loop:
1. The `branch` reads the current agent type from state
2. Routes to that type's `step.llm()` (with its specific tools)
3. The model runs with only those tools available
4. Output flows to the next iteration, where a coordinator step decides what to do next

---

## Plan Mode vs Act Mode

Plan mode restricts which agent types are available. In Noetic, this is just another layer of branching — the `route` function checks the mode and filters agent types.

### Branch-Based Mode Restriction

```typescript
const PLAN_MODE_AGENTS = new Set(['explore', 'plan', 'claude-code-guide']);
const ACT_MODE_AGENTS = new Set(['explore', 'plan', 'verification', 'general', 'claude-code-guide']);

const agentRouter = branch({
  id: 'agent-type-router',
  route: (input, ctx) => {
    const mode = ctx.state.mode ?? 'plan';
    const agentType = ctx.state.nextAgentType ?? 'explore';
    const allowed = mode === 'plan' ? PLAN_MODE_AGENTS : ACT_MODE_AGENTS;

    if (!allowed.has(agentType)) {
      // In plan mode, trying to use 'general' → fall back to 'plan'
      return planStep;
    }

    return routes[agentType] ?? exploreStep;
  },
});
```

This is a hard boundary — in plan mode, the `general` step (with write tools) literally never runs. The model never sees write tools. No steering needed for this.

### Mode Switching

The coordinator step (see next section) decides when to switch modes. It has a `set_mode` tool that updates `ctx.state.mode`:

```typescript
const setModeTool = tool({
  name: 'set_mode',
  description: 'Switch between plan mode (read-only agents) and act mode (all agents including writes).',
  input: z.object({ mode: z.enum(['plan', 'act']) }),
  output: z.object({ mode: z.enum(['plan', 'act']), previous: z.enum(['plan', 'act']) }),
  execute: async (args, toolCtx) => {
    const previous = toolCtx.ctx.state.mode;
    toolCtx.ctx.state.mode = args.mode;
    return { mode: args.mode, previous };
  },
});
```

---

## The Full Loop

The loop body has two steps per iteration:
1. **Coordinator step** — an LLM that decides what to do next (which agent type, what task). It has only delegation/control tools, no codebase tools.
2. **Agent branch** — routes to the chosen agent type's `step.llm()` with its specific tools.

```typescript
import {
  AgentHarness, loop, step, branch,
  workingMemory, observationalMemory,
} from '@noetic/core';
import { any, until } from '@noetic/core';

const MODEL = 'anthropic/claude-sonnet-4-20250514';
const ROOT_DIR = process.cwd();

// --- Tool sets (per agent type) ---
const readOnlyTools = createCodebaseTools(ROOT_DIR);
const fullTools = [...readOnlyTools, ...createWriteTools(ROOT_DIR)];
const verifyTools = [...readOnlyTools, ...createTmpWriteTools()];
const guideTools = [...readOnlyTools, ...createWebTools()];

// --- Pre-built agent steps (each with its own tools) ---
const agentSteps = {
  explore: step.llm({
    id: 'explore',
    model: 'anthropic/claude-haiku-4',
    system: 'You are a fast codebase exploration agent. Report findings concisely.',
    tools: readOnlyTools,
  }),
  plan: step.llm({
    id: 'plan',
    model: MODEL,
    system: 'You are a software architect. Produce a step-by-step implementation plan.',
    tools: readOnlyTools,
  }),
  verification: step.llm({
    id: 'verify',
    model: MODEL,
    system: 'You are an adversarial verifier. Run builds/tests/lints. End with VERDICT: PASS/FAIL/NEEDS_REVISION.',
    tools: verifyTools,
  }),
  general: step.llm({
    id: 'general',
    model: MODEL,
    system: 'Complete the task fully.',
    tools: fullTools,
  }),
  'claude-code-guide': step.llm({
    id: 'guide',
    model: 'anthropic/claude-haiku-4',
    system: 'You answer questions about Claude Code, the Agent SDK, and the Claude API.',
    tools: guideTools,
  }),
};

// --- Coordinator step (decides what agent to use next) ---
const coordinatorStep = step.llm({
  id: 'coordinator',
  model: MODEL,
  system: COORDINATOR_SYSTEM_PROMPT,
  tools: [
    setModeTool,
    selectAgentTool,  // sets ctx.state.nextAgentType
  ],
  output: z.object({
    agentType: z.enum(['explore', 'plan', 'verification', 'general', 'claude-code-guide']),
    task: z.string(),
    done: z.boolean(),
  }),
});

// --- Agent type branch ---
const PLAN_MODE_AGENTS = new Set(['explore', 'plan', 'claude-code-guide']);

const agentBranch = branch({
  id: 'agent-router',
  route: (input, ctx) => {
    const mode = ctx.state.mode ?? 'plan';
    const agentType = ctx.state.nextAgentType ?? 'explore';

    if (mode === 'plan' && !PLAN_MODE_AGENTS.has(agentType)) {
      return agentSteps.plan; // fallback in plan mode
    }
    return agentSteps[agentType] ?? agentSteps.explore;
  },
});

// --- The harness IS the agent ---
const harness = new AgentHarness({
  name: 'claude-code-agent',
  initialStep: loop({
    id: 'main-loop',
    steps: [coordinatorStep, agentBranch],
    until: any(
      until.noToolCalls(),
      until.maxSteps(50),
      until.maxCost(10),
    ),
  }),
  memory: [
    workingMemory({ scope: 'thread' }),
    observationalMemory({ bufferThreshold: 3_000 }),
  ],
  params: {},
  llm: { provider: 'openrouter' },
});

const result = await harness.execute('Add a dark mode toggle to the settings page.');
```

### How It Flows

```
Iteration 1:
  coordinatorStep → decides: { agentType: 'explore', task: 'find settings components' }
  agentBranch → exploreStep (haiku, read-only tools) → runs, returns file list

Iteration 2:
  coordinatorStep → decides: { agentType: 'plan', task: 'design dark mode toggle' }
  agentBranch → planStep (sonnet, read-only tools) → runs, returns plan

Iteration 3:
  coordinatorStep → calls set_mode({ mode: 'act' }), decides: { agentType: 'general', task: 'implement plan' }
  agentBranch → generalStep (sonnet, ALL tools including write/edit/bash) → implements

Iteration 4:
  coordinatorStep → decides: { agentType: 'verification', task: 'verify implementation' }
  agentBranch → verifyStep (sonnet, read-only + /tmp) → returns VERDICT: PASS

Iteration 5:
  coordinatorStep → { done: true } → until.noToolCalls() fires → loop ends
```

Each iteration, the model only sees the tools for its agent type. The explore step has no write tools. The general step has everything. The branch handles this — no steering needed, no dynamic step construction.

---

## Async Sub-Agents

The loop-with-branch approach above is sequential — one agent type per iteration. For parallel sub-agents (Claude Code's async delegation), you need `spawn` + `detachedSpawn` + an inbox channel. This is an extension of the base pattern, not a replacement.

### When to Use Each

| Pattern | When | How |
|---|---|---|
| **Branch in loop** | Sequential agent switching (explore → plan → implement → verify) | `branch()` routes to different `step.llm()` configs |
| **Sync spawn** | Need a sub-agent result before continuing | `spawn()` inside a `step.run()` via `harness.run()` |
| **Async detached spawn** | Can continue while sub-agent works | `detachedSpawn()` + inbox channel |

### Adding Async Delegation

Add a `launch_agent` tool to the coordinator step. When the coordinator calls it, a background sub-agent runs and posts results to the inbox:

```typescript
const inbox = channel('agent-inbox', { schema: z.string(), mode: 'queue' });
const handles = new Map<string, DetachedHandle<string>>();

const launchAgentTool = tool({
  name: 'launch_agent',
  description: 'Launch a sub-agent in the background. Results arrive via inbox.',
  input: z.object({
    type: z.enum(['explore', 'plan', 'verification', 'general', 'claude-code-guide']),
    task: z.string(),
  }),
  output: z.object({ agentId: z.string() }),
  execute: async (args, toolCtx) => {
    // Build the sub-agent step with its tools (same steps defined above)
    const agentStep = agentSteps[args.type];
    const spawnStep = spawn({ id: `sub-${args.type}`, child: agentStep });
    const handle = toolCtx.harness.detachedSpawn(spawnStep, args.task, toolCtx.ctx);
    handles.set(handle.id, handle);

    // Notify inbox when done (fire-and-forget)
    void handle.await().then(
      (result) => {
        handles.delete(handle.id);
        toolCtx.harness.send(inbox, `[Agent ${handle.id} completed] ${result}`, toolCtx.ctx);
      },
      (err: unknown) => {
        handles.delete(handle.id);
        const msg = err instanceof Error ? err.message : String(err);
        toolCtx.harness.send(inbox, `[Agent ${handle.id} failed] ${msg}`, toolCtx.ctx);
      },
    );

    return { agentId: handle.id };
  },
});
```

Add `inbox` and `parkTimeout` to the loop so it wakes up when async agents finish:

```typescript
const mainLoop = loop({
  id: 'main-loop',
  steps: [coordinatorStep, agentBranch],
  until: any(until.noToolCalls(), until.maxSteps(50)),
  inbox,
  parkTimeout: 30_000, // wait up to 30s for background agents
});
```

---

## Inter-Agent Communication

### The Inbox Channel

When the `until` predicate fires (e.g., no tool calls), the loop checks the inbox before truly stopping. If a background agent just posted a result, the loop **continues** with the result injected as a developer message.

The flow:

1. Coordinator calls `launch_agent` → sub-agent runs in background
2. Coordinator has no more tool calls → `until.noToolCalls()` fires
3. Loop checks inbox → nothing yet → parks for up to 30s
4. Sub-agent finishes → posts to inbox
5. Loop wakes → injects message → coordinator gets the result and continues

### External Channels (User Input)

For a user-facing system where new messages can arrive mid-execution:

```typescript
const userInput = channel('user-input', {
  schema: z.string(),
  mode: 'queue',
  external: true, // writable from outside the execution tree
});

// After starting the agent:
const handle = harness.getChannelHandle(userInput, ctx.id);
handle.send('Actually, also add error handling.'); // injects into the running loop
```

---

## Context Compaction

### How Claude Code Does It

A 4-stage pipeline (snip → microcompact → context collapse → autocompact) triggers when context grows too large.

### The Noetic Equivalent: Observational Memory

`observationalMemory()` buffers raw conversation items. When the buffer crosses a token threshold, it calls an `observer` function to distill them into compact observations. This is a **memory layer** — it controls what the model sees in its prompt, not what tools are available:

```typescript
import { observationalMemory } from '@noetic/core';

const compactor = observationalMemory({
  bufferThreshold: 50_000, // tokens before distilling
  maxObservations: 50,
  observer: async (buffer) => {
    return [`Summary of ${buffer.length} exchanges: ${buffer.map(b => b.slice(0, 80)).join('; ')}`];
  },
});
```

Memory layers are provided at the harness level via the `memory` option (see [The Single Harness](#the-single-harness)). Every `execute()` call creates a context with those layers attached — no `spawn` wrapper needed. If a sub-agent needs different layers, use `provide()` to override within that subtree, or `spawn()` to create a fully isolated context.

Short-lived agent types (explore, guide) don't need compaction — they run for a few iterations and terminate. Longer-running types (general, plan) benefit from it.

---

## Doom Loop Detection

### How Claude Code Does It

A lifecycle hook inspects conversation history for repetitive patterns and injects a `system_reminder` nudging the model to try a different approach.

### The Noetic Equivalent: Steering Layer

`steering()` is a memory layer that can intercept tool calls (`beforeToolCall`) and model responses (`afterModelCall`). For doom loop detection, we use `afterModelCall` to check for repetitive patterns and inject guidance:

```typescript
import { steering, SteeringAction } from '@noetic/core';

const doomLoopDetector = steering({
  rules: [{
    id: 'doom-loop-detector',
    appliesTo: ['afterModelCall'],
    predicate: (params) => {
      const items = params.ctx.itemLog.items;
      const recentToolCalls = items
        .filter((i): i is FunctionCallItem => i.type === 'function_call')
        .slice(-6);

      if (recentToolCalls.length >= 6) {
        const names = recentToolCalls.map(t => t.name);
        const isRepeating = names[0] === names[2] && names[2] === names[4];
        if (isRepeating) {
          return {
            action: SteeringAction.Guide,
            guidance: 'You are repeating the same actions. Step back and try a fundamentally different approach.',
          };
        }
      }
      return { action: SteeringAction.Allow };
    },
  }],
});
```

When `Guide` is returned, the guidance is injected as a developer message and the model is called again (up to 3 retries). Note: steering intercepts tool calls or model responses — it doesn't change which tools are available. That's the `tools` array's job.

---

## Putting It All Together

```typescript
import {
  AgentHarness, step, branch, loop, spawn, tool, channel,
  workingMemory, observationalMemory, steering, SteeringAction,
} from '@noetic/core';
import { any, until } from '@noetic/core';
import { z } from 'zod';

const MODEL = 'anthropic/claude-sonnet-4-20250514';
const ROOT_DIR = process.cwd();

// ─── Tool sets (capability boundaries per agent type) ───

const readOnlyTools = createCodebaseTools(ROOT_DIR);
const fullTools = [...readOnlyTools, ...createWriteTools(ROOT_DIR)];
const verifyTools = [...readOnlyTools, ...createTmpWriteTools()];
const guideTools = [...readOnlyTools, ...createWebTools()];

// ─── Agent steps (each with its own tools — the hard capability boundary) ───

const agentSteps: Record<string, Step> = {
  explore: step.llm({
    id: 'explore', model: 'anthropic/claude-haiku-4',
    system: 'Fast codebase exploration. Report findings concisely.',
    tools: readOnlyTools,
  }),
  plan: step.llm({
    id: 'plan', model: MODEL,
    system: 'Software architect. Produce a step-by-step implementation plan.',
    tools: readOnlyTools,
  }),
  verification: step.llm({
    id: 'verify', model: MODEL,
    system: 'Adversarial verifier. Run builds/tests/lints. End with VERDICT: PASS/FAIL/NEEDS_REVISION.',
    tools: verifyTools,
  }),
  general: step.llm({
    id: 'general', model: MODEL,
    system: 'Complete the task. Do not gold-plate, do not leave half-done.',
    tools: fullTools,
  }),
  'claude-code-guide': step.llm({
    id: 'guide', model: 'anthropic/claude-haiku-4',
    system: 'Answer questions about Claude Code, the Agent SDK, and the Claude API.',
    tools: guideTools,
  }),
};

// ─── Coordinator tools (control flow, not codebase) ───

const setModeTool = tool({
  name: 'set_mode',
  description: 'Switch between plan mode (read-only) and act mode (full capability).',
  input: z.object({ mode: z.enum(['plan', 'act']) }),
  output: z.object({ mode: z.enum(['plan', 'act']) }),
  execute: async (args, toolCtx) => {
    toolCtx.ctx.state.mode = args.mode;
    return { mode: args.mode };
  },
});

const selectAgentTool = tool({
  name: 'select_agent',
  description: 'Choose which agent type handles the next task.',
  input: z.object({
    type: z.enum(['explore', 'plan', 'verification', 'general', 'claude-code-guide']),
  }),
  output: z.object({ selected: z.string() }),
  execute: async (args, toolCtx) => {
    toolCtx.ctx.state.nextAgentType = args.type;
    return { selected: args.type };
  },
});

// ─── Coordinator step (decides what to do, has no codebase tools) ───

const coordinatorStep = step.llm({
  id: 'coordinator',
  model: MODEL,
  system: `You are a software engineering coordinator.

## Modes
You start in PLAN mode. In plan mode: explore, plan, and guide agents only.
Call set_mode({ mode: "act" }) to enable general and verification agents.

## Agent Types (use select_agent to choose)
- explore:           Fast read-only codebase search (cheap)
- plan:              Software architect — produces implementation plans
- verification:      Adversarial verifier — outputs VERDICT
- general:           Full capability including file writes (only type that can edit code)
- claude-code-guide: Documentation lookup (cheap)

## Workflow
1. select_agent → explore (understand codebase)
2. select_agent → plan (design approach)
3. set_mode → act
4. select_agent → general (implement)
5. select_agent → verification (validate)`,
  tools: [setModeTool, selectAgentTool],
});

// ─── Branch: routes to the selected agent type's step.llm ───

const PLAN_MODE_AGENTS = new Set(['explore', 'plan', 'claude-code-guide']);

const agentBranch = branch({
  id: 'agent-router',
  route: (input, ctx) => {
    const mode = ctx.state.mode ?? 'plan';
    const agentType = ctx.state.nextAgentType ?? 'explore';

    // Plan mode blocks write-capable agents
    if (mode === 'plan' && !PLAN_MODE_AGENTS.has(agentType)) {
      return agentSteps.plan;
    }
    return agentSteps[agentType] ?? agentSteps.explore;
  },
});

// ─── The harness IS the agent ───

const harness = new AgentHarness({
  name: 'claude-code-agent',
  initialStep: loop({
    id: 'main-loop',
    steps: [coordinatorStep, agentBranch],
    until: any(
      until.noToolCalls(),
      until.maxSteps(50),
      until.maxCost(10),
    ),
  }),
  memory: [
    doomLoopDetector,                                // steering: intercepts repetitive patterns
    workingMemory({ scope: 'thread' }),              // prompt: scratchpad for task state
    observationalMemory({ bufferThreshold: 3_000 }), // prompt: compressed history
  ],
  params: {},
  llm: { provider: 'openrouter' },
});

const result = await harness.execute('Add a dark mode toggle to the settings page.');
```

### Execution Flow

```
Iteration 1:
  coordinator → select_agent({ type: 'explore' })
  branch → exploreStep (haiku, read-only tools)
  → "Found SettingsPage.tsx, ThemeContext.tsx..."

Iteration 2:
  coordinator → select_agent({ type: 'plan' })
  branch → planStep (sonnet, read-only tools)
  → "Plan: 1) Add dark mode to ThemeContext  2) Add toggle component  3) Wire to settings..."

Iteration 3:
  coordinator → set_mode({ mode: 'act' }), select_agent({ type: 'general' })
  branch → generalStep (sonnet, ALL tools — write_file, edit_file, bash)
  → writes DarkModeToggle.tsx, edits ThemeContext.tsx, edits SettingsPage.tsx

Iteration 4:
  coordinator → select_agent({ type: 'verification' })
  branch → verifyStep (sonnet, read-only + /tmp bash)
  → runs build, tests, linter → "VERDICT: PASS"

Iteration 5:
  coordinator → no tool calls → loop ends
```

---

## What Doesn't Map Directly

| Claude Code Feature | Gap | Possible Workaround |
|---|---|---|
| **Streaming tokens to UI** | `callModel()` returns completed responses, no SSE surface | Wrap the OpenRouter SDK's streaming directly, outside of Noetic's step model |
| **Agent continuation** (`SendMessage` to existing agent) | `detachedSpawn` is fire-and-forget; can't add messages to a running agent's conversation | Use `inbox` channel on the sub-agent's loop — messages arrive as developer items via `parkTimeout` |
| **Request transformer pipeline** (SortTools, ImageHandling, etc.) | No user-facing request transform hook | Implement in a memory layer's `recall` hook (for prompt-side transforms) |
| **Interactive permission prompts** (`needsApproval` → user confirms in UI) | The flag exists on `tool()` but has no built-in UI | Pause on `ctx.recv(approvalChannel)`, external UI calls `handle.send('approved')` |
| **Dynamic model downgrade** (200k+ context → cheaper model in plan mode) | `step.llm` model is fixed at build time | Use `branch()` to route to different `step.llm` configs based on `ctx.tokens.total` |
| **Prompt cache key preservation** | Provider-specific optimization not exposed | Would require a custom adapter layer |
| **tmux pane routing for teams** | No process/terminal management | External concern — Noetic handles agent logic, not UI |
| **`criticalSystemReminder`** (re-injected every turn for verification) | No per-turn system injection outside memory layers | Use `staticContent({ load: async () => reminder })` — it injects at `recall`, which fires before every LLM call |
