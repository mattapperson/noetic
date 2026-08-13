# @noetic-tools/context

The context layer system for Noetic agents.

A *context layer* is a composable unit that shapes what an agent sees in its
context window — capping history, summarising old turns, tracking a plan,
exposing tool results, redacting items, and steering tool calls. This package
provides:

- The **`ContextLayer` contract** — the interface every layer implements.
- The **lifecycle, budget, and projection machinery** that converges layer
  outputs into the assembled LLM context (`assembleView`, `allocateBudgets`,
  layer state stores, scoping), plus the **compaction helpers**
  (`foldCompactions`, `historyPressure`, `createCompaction`, `compactHistory`)
  for replacing an old history prefix with a logged summary.
- The **built-in layers**: instructions, history, scratchpad, observations,
  temporal, filesystem, plan, task state, tool calls, and steering.

It depends only on [`@noetic-tools/types`](https://www.npmjs.com/package/@noetic-tools/types).
[`@noetic-tools/core`](https://www.npmjs.com/package/@noetic-tools/core) builds
on it and re-exports its public surface, so application code typically imports
context layers from `@noetic-tools/core`.

> Formerly published as `@noetic-tools/memory`. That package still resolves — it
> re-exports everything here — but is deprecated and will stop being updated.

## License

Apache-2.0
