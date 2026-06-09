# @noetic-tools/memory

The memory layer system for Noetic agents.

A *memory layer* is a composable unit that shapes what an agent sees in its
context window — capping history, summarising old turns, tracking a plan,
exposing tool results, redacting items, and steering tool calls. This package
provides:

- The **`MemoryLayer` contract** — the interface every layer implements.
- The **lifecycle, budget, and projection machinery** that converges layer
  outputs into the assembled LLM context (`assembleView`, `allocateBudgets`,
  layer state stores, scoping).
- The **built-in layers**: working memory, history window, observational
  memory, plan, temporal, steering, file reference, static content, durable
  task state, and the tool memory layer.

It depends only on [`@noetic-tools/types`](https://www.npmjs.com/package/@noetic-tools/types).
[`@noetic-tools/core`](https://www.npmjs.com/package/@noetic-tools/core) builds
on it and re-exports its public surface, so application code typically imports
memory layers from `@noetic-tools/core`.

## License

Apache-2.0
