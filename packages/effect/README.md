# @noetic-tools/effect

[Effect](https://effect.website) (effect-ts) adapter for [Noetic](https://github.com/mattapperson/noetic) — run Effect v4 programs as supervised Noetic steps.

## Install

```sh
bun add @noetic-tools/effect effect
```

`effect` (v4) is an **optional peer dependency** — install the version your program needs.

## Usage

```ts
import { effectStep } from '@noetic-tools/effect';
import { effectStep as makeEffectStep } from '@noetic-tools/core';
import { Effect } from 'effect';

const runtime = effectStep({
  program: (input: string) => Effect.sync(() => input.toUpperCase()),
  stepId: 'shout',
  describe: { summary: 'uppercase the input' },
});

const step = makeEffectStep({ id: 'shout', runtime });
```

The interpreter supervises the program: retry policy (`step.retry`), framework events, durable replay, and error normalization all behave exactly like a native step. Noetic aborts interrupt the Effect fiber through the context's `AbortSignal`; an interrupted program surfaces as a `NoeticError` of kind `cancelled`, so loops, `inParallel` settle forks, and durable resumes see the same error surface as native steps.

Typed Effect failures map to `step_failed` by default; provide `mapError` to translate your error type into a `NoeticError` payload instead. Defects (`Effect.die`) surface as `step_failed` around the defect and never reach the mapper.

## JSON workflows

Reference a registered runtime by name from a workflow document:

```json
{ "kind": "effect", "id": "shout", "ref": "shout" }
```

```ts
hydrateWorkflow(doc, {
  effectRuntimes: new Map([['shout', runtime]]),
});
```

## Architecture

This package depends only on `@noetic-tools/types` (+ `effect` as an optional peer). `@noetic-tools/core` never imports it — it resolves `EffectStepRuntime` through the structural contract in `@noetic-tools/types`, the same isolation shape as the sub-harness adapters.

## License

Apache-2.0
