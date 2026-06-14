# @noetic-tools/sub-harness-opencode

Run the [opencode](https://opencode.ai) agent as a Noetic step.

```ts
import { opencode } from '@noetic-tools/sub-harness-opencode';

const flow = step.opencode({
  id: 'fix-bug',
  harness: opencode({ model: 'anthropic/claude-opus-4-8' }),
  prompt: 'Fix the failing test in src/foo.ts',
});
```

## Install

```sh
bun add @noetic-tools/sub-harness-opencode @opencode-ai/sdk
```

`@opencode-ai/sdk` is an optional peer dependency. The default runner loads it
lazily, so the package installs and type-checks without it; a missing SDK
surfaces as a `SubHarnessStartError` when a turn runs. Pass a custom `runner`
to drive opencode some other way (e.g. its CLI) or in tests.

## API

- `opencode(options?)` — build the opencode `SubHarness`. `options` extends the
  shared `SubHarnessSettings` (`model`, `permissionMode`, `maxTurns`,
  `allowedTools`, `extra`) plus an optional `runner` override.
- `defaultOpencodeRunner` — the SDK-backed turn runner.
- `mapOpencodeMessage(message)` — map one opencode message/event into normalized
  `SubHarnessStreamPart`s.
