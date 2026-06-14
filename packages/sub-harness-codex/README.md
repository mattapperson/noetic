# @noetic-tools/sub-harness-codex

Codex sub-harness for [Noetic](https://github.com/mattapperson/noetic). Run
OpenAI's Codex agent as a Noetic step via `step.codex(...)` or a `codex` JSON
workflow node.

## Install

```bash
bun add @noetic-tools/sub-harness-codex @openai/codex-sdk
```

`@openai/codex-sdk` is an **optional peer dependency** — the package installs
and type-checks without it. The default runner loads it lazily at runtime and
throws a `SubHarnessStartError` if it is missing. Pass a custom `runner` to use
the Codex CLI or a mock instead.

## Usage

```ts
import { step } from '@noetic-tools/core';
import { codex } from '@noetic-tools/sub-harness-codex';

const flow = step.codex({
  id: 'fix-bug',
  harness: codex({ model: 'gpt-5.3-codex' }),
  prompt: 'Fix the failing test in src/auth.ts',
});
```

`codex(options)` accepts the shared `SubHarnessSettings` (`model`,
`permissionMode`, `maxTurns`, `allowedTools`, `extra`) plus an optional `runner`
override.

## Built-in tools

The adapter advertises Codex's native tools mapped to Noetic's common-tool
vocabulary:

| Native        | Common      |
| ------------- | ----------- |
| `shell`       | `shell`     |
| `read_file`   | `read-file` |
| `apply_patch` | `edit-file` |

## Custom runner

```ts
import { codex } from '@noetic-tools/sub-harness-codex';
import type { SubHarnessRunner } from '@noetic-tools/sub-harness';

const runner: SubHarnessRunner = async function* (input) {
  // yield SubHarnessStreamParts for one turn
};

const harness = codex({ runner });
```

`mapCodexMessage` and `defaultCodexRunner` are exported for composing or testing
custom runners.

## License

Apache-2.0
