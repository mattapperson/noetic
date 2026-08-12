# Patterns

> **Depends On:** `01-step-type` (Step, execute), `02-step-variants` (runCode, callModel, invokeTool, Tool), `03-control-flow` (conditional, inParallel), `04-spawn` (spawn, context), `05-loop-and-until` (loop, until, any, all), `06-channels` (channel, ExternalChannel, ChannelHandle, tryRecv), `07-context-and-event-log` (Context, Item, ItemLog), `11-context-layer-system` (context layer lifecycle)
> **Exports:** `createDetachedSignal()`, `runnableLoop()`, `createStallNudgeHook()`, `createNudgeMessage()`, `seedFromItems()`, `DEFAULT_NUDGE_MESSAGE_TEXT`, `DetachedSignal`, `RunnableLoopOpts`, `RunnableLoopHarness`, `AfterFirstTurnContext`, `StallNudgeOpts`, `CreateNudgeMessageOpts`, `SessionSeedHarness`

---

## Patterns Are Compositions, Not Builders

`@noetic-tools/core` ships **no bundled agent patterns**. There is no `react()` builder, no verify-and-retry builder, no plan compiler. A pattern is 15-30 lines of primitive composition that lives in application code.

This is the point of the primitive set, not a gap in it. A pattern baked into the framework fixes its own termination rules, context boundaries, and feedback shape; every real agent eventually needs to change one of those, and then the built-in becomes an obstacle. Composed locally, a pattern is ordinary code the author can read, fork, and instrument.

The primitives every pattern in this document draws on:

| Concern | Primitive | Spec |
|---------|-----------|------|
| Deterministic work | `runCode` | `02-step-variants` |
| Model call with tools | `callModel` | `02-step-variants` |
| Direct tool invocation | `invokeTool` | `02-step-variants` |
| Iteration + termination | `loop`, `until.*`, `any`, `all`, `prepareNext` | `05-loop-and-until` |
| Routing | `conditional` | `03-control-flow` |
| Fan-out | `inParallel` (`all` / `race` / `settle`) | `03-control-flow` |
| Context isolation | `spawn`, `withContext` | `04-spawn`, `11-context-layer-system` |
| Cross-boundary state | context layers | `11-context-layer-system` |
| External messaging | `channel`, `ExternalChannel`, `ChannelHandle` | `06-channels` |
| Delegating to a coding agent | `step.claudeCode`, `step.codex`, `step.opencode`, `step.pi` | `27-sub-harness-steps` |

The one runtime-shaped exception is the **JSON workflow runtime** (`dynamicWorkflow`, `parseAndRunWorkflow`), which hydrates a validated `WorkflowDocument` into a native `Step` tree so the *shape* can be produced at runtime by a model. It is a runtime, not a pattern — see `26-json-workflow-runtime`.

---

## Runnable Compositions

Each of these is executable source in the repository, kept working as the primitive set evolves. They are the normative examples of "what a pattern looks like".

| Composition | Where | Primitives |
|-------------|-------|------------|
| ReAct | `packages/core/examples/react-agent.ts` | `loop` + `callModel` + `until.noToolCalls` + optional `spawn` |
| ReAct (eval variant) | `packages/eval/evals/agents.ts` (`reactAgent`) | `loop` + `callModel` + `any(until.noToolCalls, until.maxSteps)` |
| Verify-and-retry with fresh context | `packages/eval/evals/agents.ts` (`retryWithFeedback`) | `loop` + `spawn` + `until.verified` + `prepareNext` |
| Keyword routing | `packages/core/examples/branching-agent.ts` | `conditional` + `runCode` + `callModel` + `loop` |
| Parallel research fan-out | `packages/core/examples/parallel-research.ts` | `inParallel` (`all`) + `spawn` + `callModel` + merge |
| Staged pipeline | `packages/core/examples/pipeline-agent.ts` | `conditional` as sequencer + `prepareNext` |
| Sync sub-agent delegation | `packages/core/examples/sync-delegate.ts` | tool → `spawn` (parent blocks) |
| Async sub-agent delegation | `packages/core/examples/async-delegate.ts` | tool → detached spawn + inbox `channel` |
| Model-chosen delegation | `packages/core/examples/dynamic-delegate.ts` | both delegation tools, selected by tool call |
| LLM-generated workflow (judge / mixture-of-agents) | `packages/core/examples/dynamic-judge-workflow.ts` | `dynamicWorkflow` + `inParallel` + `callModel` |
| Middleware-stack agent | `packages/core/examples/deep-agent/` | tools + context layers + `spawn` |

---

## ReAct

ReAct is: call the model with tools, repeat until it stops calling tools.

```typescript
// Application code, not a core export. Runnable source: packages/core/examples/react-agent.ts
function react(opts: {
  model: string;
  instructions?: string;
  tools: Tool[];
  maxSteps?: number;
  maxCost?: number;
  context?: ContextConfig | ContextLayer[];
}) {
  const llmStep = callModel({
    id: 'react-step',
    model: opts.model,
    instructions: opts.instructions,
    tools: opts.tools,
  });

  const loopStep = loop({
    id: 'react-loop',
    steps: [llmStep],
    until: any(
      until.noToolCalls(),
      until.maxSteps(opts.maxSteps ?? 10),
      ...(opts.maxCost ? [until.maxCost(opts.maxCost)] : []),
    ),
  });

  if (!opts.context) {
    return loopStep;
  }
  return spawn({ id: 'react-agent', child: loopStep, context: opts.context });
}
```

**ItemLog strategy:** accumulate. Without a `spawn` boundary, tool results append to the ItemLog and the context layer `recall()`/`store()` lifecycle runs on every iteration.

---

## Verify-and-Retry with Fresh Context

An outer loop where each iteration runs an inner agent inside `spawn`, so every attempt starts from a fresh ItemLog. Everything that must survive an attempt is held by context layers; the verifier's feedback re-enters through `prepareNext`.

```typescript
// Application code, not a core export. Runnable source: packages/eval/evals/agents.ts
function retryWithFeedback(opts: {
  model: string;
  instructions: string;
  tools: Tool[];
  verify: VerifyFn;
  maxIterations?: number;
  innerMaxSteps?: number;
}) {
  const inner = react({
    model: opts.model,
    instructions: opts.instructions,
    tools: opts.tools,
    maxSteps: opts.innerMaxSteps ?? 20,
  });

  return loop({
    id: 'retry-with-feedback-loop',
    steps: [spawn({ id: 'retry-iteration', child: inner })],
    until: any(
      until.verified(opts.verify),
      until.maxSteps(opts.maxIterations ?? 50),
    ),
    prepareNext: (_output, verdict) => {
      if (verdict.feedback) {
        return `Previous attempt feedback: ${verdict.feedback}\nContinue working.`;
      }
      return 'Continue working on the task.';
    },
  });
}
```

**Context layer interaction:** `taskState()` carries task artifacts across the fresh boundary, `scratchpad({ scope: 'resource' })` carries structured progress, and `observations()` compresses what earlier attempts learned into the next View. See `12-builtin-context-layers`.

---

## Subprocess Routing

Every spawn-based composition routes through the harness `SubprocessAdapter` — in-memory by default, out-of-process when the caller supplies a different adapter via `spawn({ subprocess })` or `harness.detachedSpawn(step, input, ctx, { subprocess })`. Precedence is `overrides ?? step ?? harness`.

Adapter routing is transparent to the composition: none of the shapes above change when the adapter does. See `04-spawn` for the routing rules and `23-durable-execution` for durability once an out-of-process adapter is in play.

---

## Runner-Loop Primitives

A long-lived runner loop — a daemon, a CI wrapper, a service that owns one agent thread and drives it to an outcome — is not a step composition. It sits *outside* the interpreter, seeding a session, driving turns, and waiting on an outcome that may arrive from an external event rather than from a step returning. `@noetic-tools/core` exports the small pieces of that shape so runner loops do not each reinvent them:

- **`createDetachedSignal<T>()`** → `DetachedSignal<T>`: a single-shot resolve/reject signal whose `done` promise carries the loop's final outcome.
- **`runnableLoop(opts: RunnableLoopOpts<T>): Promise<T>`**: the generic turn driver over a `RunnableLoopHarness` (`seedSessionHistory`, `execute`, `getAgentResponse`). With `priorItems` it seeds the session and awaits the signal; with `initialMessage` it seeds, runs the first turn, invokes `afterFirstTurn`, then awaits the signal; with neither it is a pure listener.
- **`createStallNudgeHook(opts: StallNudgeOpts<T>)`**: a two-strike `afterFirstTurn` hook. On the first stall it sends one nudge, then awaits the nudged turn's *real* completion via `harness.getAgentResponse` raced against the outcome signal — `execute()` is enqueue-only, so a microtask-scale wait would always escalate. If the loop is still stalled on the re-check it calls `onStall()` and settles the signal with `buildStalledOutcome()`. A settled signal or a pending external message short-circuits either strike.
- **`createNudgeMessage(opts: CreateNudgeMessageOpts)`** and **`DEFAULT_NUDGE_MESSAGE_TEXT`**: build the nudge `InputMessageItem` the hook sends.
- **`seedFromItems(harness: SessionSeedHarness, threadId, items)`**: path-free session seeding from an `Item[]` the caller has already loaded; a no-op on an empty array.

They are exported, not internal, so third-party runners (custom agents, CI wrappers, daemons) can assemble the same shape against any `SubprocessAdapter`.

---

## Future Considerations

- **A pattern cookbook package.** The compositions above live as examples so they stay executable. A separate, versioned `@noetic-tools/patterns` package could ship them as copy-ready source (not as re-exported builders) with their own tests.
- **Recursive decomposition helper.** Self-spawning decompose/merge agents currently repeat depth bookkeeping in user code; a depth-aware `spawn` helper (reading `ctx.depth`) would remove that boilerplate without reintroducing a pattern builder.
- **Remote steps.** An agent reachable over HTTP is `spawn` + `runCode` behind a transport. A first-class remote step would need task lifecycle, streaming, and capability negotiation to be runtime concerns rather than composition concerns.
