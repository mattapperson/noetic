# Noetic

A TypeScript agent framework that decomposes AI agent patterns into eight composable step primitives. Noetic treats context boundary management as a first-class concern and provides a pluggable context system with well-defined lifecycle hooks.

## Philosophy

- **Everything is a `Step<I, O>`** — a typed, serializable unit of work
- **No hidden control flow** — no magic base classes, no runtime surprises
- **Primitives compose freely** — a loop can contain a conditional, which can contain parallel spawned agents
- **Context is pluggable** — agents pay only for the features they use

## Packages

| Package | Description |
|---------|-------------|
| [`@noetic-tools/core`](packages/core) | Core framework — step primitives, agent harness, context layers, patterns |
| [`@noetic-tools/eval`](packages/eval) | Scored evaluation, GEPA-based prompt optimization, regression testing |
| [`@noetic/web`](packages/web) | Documentation site (Next.js + Fumadocs) |

## The Eight Primitives

| Primitive | Kind | Purpose |
|-----------|------|---------|
| `step.runCode` | `runCode` | Pure async computation with retry support |
| `step.callModel` | `callModel` | LLM call with tools, structured output, and layered context |
| `step.claudeCode` | `claude-code`, `codex`, `opencode`, `pi` | Delegate a turn to a coding agent (sub-harness) |
| `step.invokeTool` | `invokeTool` | Direct tool execution with Zod-validated I/O |
| `conditional` | `conditional` | Conditional routing — returns a step or null |
| `inParallel` | `inParallel` | Parallel execution — race, all, or settle modes |
| `spawn` | `spawn` | Child execution with an isolated context boundary |
| `loop` | `loop` | Iteration with termination predicates and an inbox |

Patterns like ReAct, Ralph Wiggum, task trees, and thread weaving are 15–30 line compositions of these primitives.

## Getting Started

**Prerequisites:** [Bun](https://bun.sh)

```bash
bun install
```

### Running tests

```bash
# All packages
bun test

# Single package
cd packages/core && bun test
```

### Type checking

```bash
cd packages/core && bun run typecheck
cd packages/eval && bun run typecheck
```

### Linting and formatting

```bash
# Root — runs Biome across the whole repo
bun run lint
bun run lint:fix
bun run format
```

### Documentation site

```bash
cd packages/web
bun run dev    # localhost:3000
bun run build
```

## Quick Example

```typescript
import { step, loop, until } from '@noetic-tools/core';
import { AgentHarness } from '@noetic-tools/core/runtime';

// A ReAct agent is just a loop of LLM calls
const agent = loop(
  step.callModel({
    model: 'openai/gpt-4o',
    system: 'You are a helpful assistant.',
    tools: [searchTool, calculatorTool],
  }),
  until.noToolCalls(),
);

const harness = new AgentHarness();
const result = await harness.run(agent, { query: 'What is 12! ?' });
```

## Context Layers

Context layers participate in execution via lifecycle hooks (`init`, `recall`, `store`, `onSpawn`, `onReturn`, `onComplete`, `dispose`). Built-in layers cover common patterns:

| Layer | Slot | Purpose |
|-------|------|---------|
| `scratchpad` | 100 | Short-term facts and observations |
| `observations` | 200 | Timestamped event log |
| `taskState` | 250 | Persisted task artifacts |
| `instructions` | 350 | Unchanging background facts |
| `toolCalls` | auto | Per-tool state from `Tool.context` declarations |

## Evaluation

The `@noetic-tools/eval` package provides a `describe`/`it` API for scored evaluations and GEPA-based prompt optimization:

```typescript
import { describe, it, scorer } from '@noetic-tools/eval';

describe(myAgent, { objective: 'Answers factual questions', passThreshold: 0.8 }, () => {
  it('answers factual questions', async (ctx) => {
    const exec = await ctx.execute('What is the capital of France?');
    await exec.score([scorer.answerRelevancy(), scorer.completeness()]);
  });
});
```

```bash
noetic-eval          # Run evaluations
noetic-eval -u       # Run GEPA optimization
```

## Tech Stack

- **Runtime:** Bun, TypeScript 5.9
- **LLM Integration:** `@openrouter/sdk` (peer dependency)
- **Validation:** Zod 4
- **Testing:** Bun test
- **Linting:** Biome
- **Docs:** Next.js, Fumadocs, Tailwind CSS 4

## Specs

Detailed specifications live in [`specs/`](specs/), covering every primitive, the context system, error model, observability, and patterns.

The specs are consumed by [SpecBuilt](https://github.com/mattapperson/spec-built), which automatically implements new features and modifies existing code to keep the implementation aligned with the specs.

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup,
the Developer Certificate of Origin (DCO) sign-off requirement, and the PR process.
Please also read our [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). To report a security
vulnerability, follow [`SECURITY.md`](SECURITY.md). Common questions are answered in the
[FAQ](docs/FAQ.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [`NOTICE`](NOTICE) for
attribution.
