# @noetic-tools/sub-harness

Base contract and helpers for **Noetic sub-harnesses** — adapters that drive an
external coding agent (Claude Code, Codex, opencode, pi) as a Noetic step, the
same way `step.llm` drives a model.

Each agent lives in its own `@noetic-tools/sub-harness-<name>` package and
implements the `SubHarness` contract re-exported here. The Noetic interpreter
runs a sub-harness via `step.claudeCode(...)`, `step.codex(...)`, etc., or via a
`{ "kind": "claude-code", ... }` node in a JSON workflow.

## What's here

- **`SubHarness` / `SubHarnessSession`** — the contract every adapter implements
  (re-exported from `@noetic-tools/types`). One `doStart` entry point yields a
  session with a full turn lifecycle (`doPromptTurn`, `doContinueTurn`,
  `doSuspendTurn`, `doStop`, `doDetach`, `doDestroy`, `doCompact`).
- **`SubHarnessStreamPart` (+ Zod schema)** — the event model an adapter emits
  during a turn.
- **`SubHarnessTurnAccumulator`** — collects stream parts into a
  `SubHarnessTurnResult` (assistant message + tool-call Items, text, usage).
- **`assistantMessageItem` / `functionCallItem`** — build Noetic `Item`s from
  agent output.
- **`createSubHarnessRegistry`** — key adapters by id for JSON-workflow
  hydration (`HydrationContext.subHarnesses`).
- **`commonTool`** — declare the cross-harness built-in tool vocabulary.
- **`SubHarnessCapabilityError` / `SubHarnessStartError`** — shared error types.

## Implementing a sub-harness

```ts
import {
  type SubHarness,
  SubHarnessTurnAccumulator,
} from '@noetic-tools/sub-harness';

export function myAgent(settings?: MyAgentSettings): SubHarness {
  return {
    specificationVersion: 'harness-v1',
    harnessId: 'claude-code',
    async doStart({ ctx, instructions }) {
      // spin up the agent (CLI subprocess or SDK) in ctx.cwd
      return {
        sessionId: '…',
        isResume: false,
        async doPromptTurn({ prompt, emit }) {
          const acc = new SubHarnessTurnAccumulator({ emit });
          // …feed acc.push(part) for each agent event…
          return acc.result();
        },
        async doStop() {
          return { harnessId: 'claude-code', sessionId: '…', state: null };
        },
      };
    },
  };
}
```

The Noetic **core** package never imports a sub-harness adapter — it depends only
on the `SubHarness` *type* and resolves adapter *instances* you pass in. See the
[Noetic docs](https://noetic.tools) for the full guide.
