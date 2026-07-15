# Noetic

A TypeScript agent framework that decomposes AI agent patterns into eight composable step primitives. Noetic treats context boundary management as a first-class concern and provides a pluggable memory system with well-defined lifecycle hooks.

## Philosophy

- **Everything is a `Step<I, O>`** — a typed, serializable unit of work
- **No hidden control flow** — no magic base classes, no runtime surprises
- **Primitives compose freely** — a loop can contain a branch, which can contain forked spawned agents
- **Memory is pluggable** — agents pay only for the features they use

## Packages

| Package | Description |
|---------|-------------|
| [`@noetic-tools/core`](packages/core) | Core framework — step primitives, agent harness, memory layers, patterns |
| [`@noetic/eval`](packages/eval) | Scored evaluation, GEPA-based prompt optimization, regression testing |
| [`@noetic/web`](packages/web) | Documentation site (Next.js + Fumadocs) |

## The Eight Primitives

| Primitive | Kind | Purpose |
|-----------|------|---------|
| `step.run` | `run` | Pure async computation with retry support |
| `step.llm` | `llm` | LLM call with tools, structured output, and memory context |
| `step.claudeCode` | `claude-code`, `codex`, `opencode`, `pi` | Delegate a turn to a coding agent (sub-harness) |
| `step.tool` | `tool` | Direct tool execution with Zod-validated I/O |
| `branch` | `branch` | Conditional routing — returns a step or null |
| `fork` | `fork` | Parallel execution — race, all, or settle modes |
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
  step.llm({
    model: 'openai/gpt-4o',
    system: 'You are a helpful assistant.',
    tools: [searchTool, calculatorTool],
  }),
  until.noToolCalls(),
);

const harness = new AgentHarness();
const result = await harness.run(agent, { query: 'What is 12! ?' });
```

## Memory Layers

Memory layers participate in execution via lifecycle hooks (`init`, `recall`, `store`, `onSpawn`, `onReturn`, `onComplete`, `dispose`). Built-in layers cover common patterns:

| Layer | Slot | Purpose |
|-------|------|---------|
| `workingMemory` | 100 | Short-term facts and observations |
| `observationalMemory` | 200 | Timestamped event log |
| `durableTaskState` | 250 | Persisted task artifacts |
| `staticContent` | 350 | Unchanging background facts |
| `toolMemoryLayer` | auto | Per-tool state from `Tool.memory` declarations |

## Evaluation

The `@noetic/eval` package provides a `describe`/`it` API for scored evaluations and GEPA-based prompt optimization:

```typescript
import { describe, it } from '@noetic/eval';
import { answerRelevancy, completeness } from '@noetic/eval/scorers';

describe('my agent', { target: myAgent }, () => {
  it('answers factual questions', {
    input: { query: 'What is the capital of France?' },
    scorers: [answerRelevancy(), completeness()],
    threshold: 0.8,
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

Detailed specifications live in [`specs/`](specs/), covering every primitive, the memory system, error model, observability, and patterns.

The specs are consumed by [SpecBuilt](https://github.com/mattapperson/spec-built), which automatically implements new features and modifies existing code to keep the implementation aligned with the specs.

## License

MIT
