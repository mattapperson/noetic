# @noetic-tools/sub-harness-pi

Run the [Pi](https://github.com/pi-agent) coding agent as a Noetic step.

Pi runs as an in-process Node library, so there is no separate CLI or sandbox to
spawn. The default runner lazily imports `@pi-agent/sdk` (an optional peer
dependency); install it to use the built-in runner, or pass your own `runner`.

```ts
import { pi } from '@noetic-tools/sub-harness-pi';

const step = harness.step.pi({
  id: 'fix-bug',
  harness: pi({ model: 'pi-default' }),
  prompt: 'Fix the failing test in src/foo.ts',
});
```

## Install

```sh
bun add @noetic-tools/sub-harness-pi @pi-agent/sdk
```

`@pi-agent/sdk` is optional — without it the default runner throws a
`SubHarnessStartError`, and you must supply a custom `runner`.
