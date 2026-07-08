# @noetic-tools/openui

Generative UI for Noetic agents via the [OpenUI](https://www.openui.com)
standard.

Instead of answering with a text blob, an agent answers with a *user interface*
built from components you registered. This package provides:

- The **`openUi()` output codec** — plug a component library into `step.llm` as a
  streaming output dialect; the model emits [OpenUI Lang](https://www.openui.com)
  and the step returns a materialized `UiDocument`.
- The **`openUiSurface()` memory layer** — the server-authoritative owner of UI
  state: durable, resumable, visible to the model via recall, and conditionable
  by the step graph. The client renderer is a projection of this layer, never the
  other way around.
- The typed **`fragment()` builder** — tool-authored UI, so a tool's calls and
  results carry their own render fragments.
- **`ui.*` until-predicates** (`ui.submitted`, `ui.interacted`, `ui.toAssistant`)
  for interaction loops built from plain composition.
- The transport at the **`./server`** subpath — `serveOpenUi()`, a web-standard
  fetch handler that speaks the OpenUI protocol over an `AgentHarness`.

It depends only on [`@noetic-tools/memory`](https://www.npmjs.com/package/@noetic-tools/memory)
and [`@noetic-tools/types`](https://www.npmjs.com/package/@noetic-tools/types) —
never on `@noetic-tools/core`. Core sees two dialect-agnostic contracts
(`OutputCodec` and `UiFragment`) and resolves the OpenUI implementation from this
package.

## Install

```bash
npm install @noetic-tools/openui
```

## Quick example

```ts
import { AgentHarness, type ContextMemory, step } from '@noetic-tools/core';
import { createLibrary, defineComponent, openUi } from '@noetic-tools/openui';
import { z } from 'zod';

const library = createLibrary([
  defineComponent({ name: 'Card', props: z.object({ title: z.string(), children: z.array(z.unknown()) }) }),
  defineComponent({ name: 'Text', props: z.object({ value: z.string() }) }),
]);

const dashboard = step.llm<ContextMemory, string, unknown>({
  id: 'dashboard',
  model: 'claude-sonnet-5',
  output: openUi(library), // the model authors your UI instead of prose
});

const harness = new AgentHarness({ name: 'ui-agent', initialStep: dashboard, params: {} });
const ctx = harness.createContext();
const doc = await harness.run(dashboard, 'Show a welcome card', ctx);
```

See the [Generative UI docs](https://noetic.tools/docs/framework/generative-ui)
for the surface layer, tool-authored fragments, and the transport.

## License

Apache-2.0
