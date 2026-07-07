# 28 — Generative UI (OpenUI)

Noetic agents render user interfaces through [OpenUI](https://www.openui.com), the
open standard for generative UI: the developer registers a component library, the
model (or a tool) emits OpenUI Lang — a token-efficient, line-oriented syntax —
and a client renderer materializes it progressively. Noetic's support has three
surfaces that compose but adopt independently:

1. **Transport** — an OpenUI-speaking server boundary around `AgentHarness`, so
   OpenUI's own client stack (`@openuidev/react-ui`) talks to a Noetic agent.
2. **Model-authored UI** — an output codec on `step.llm` that parses streamed
   OpenUI Lang, paired with a memory layer that owns the resulting UI state.
3. **Tool-authored UI** — a per-tool declaration of programmatic render
   functions, so tool calls and results carry their own UI fragments.

The design center is **server-authoritative UI state**: the `openUiSurface()`
memory layer is the single owner of the mounted document, reactive variables,
and interaction record. The client renderer is a projection of layer state —
never the other way around. This is what makes generative UI durable,
resumable, visible to the model, and conditionable by the step graph.

## Packages

```
openui ──→ memory ──→ types
core ──→ types            (core never imports openui)
```

- **`@noetic-tools/types`** — owns the two dialect-agnostic contracts:
  `OutputCodec` (generalizing `StepLLM.output`) and `UiFragment` /
  `ToolUiDeclaration` (on `Tool`). Neither mentions OpenUI; both are string- and
  schema-shaped so `types` stays a dependency leaf.
- **`@noetic-tools/openui`** — everything OpenUI-specific: the `openUi()` output
  codec (streaming OpenUI Lang parser), the `openUiSurface()` memory layer, the
  typed `fragment()` builder, `ui.*` until-predicates, the ask-user renderer,
  and library/prompt generation. Depends on `@noetic-tools/memory` and
  `@noetic-tools/types` only.
- **`@noetic-tools/openui/server`** — the transport: `serveOpenUi()` plus the
  client-side `noeticStreamAdapter()` / `noeticMessageFormat` pair consumed by
  OpenUI's `fetchLLM`.

`@noetic-tools/core` imports only the contracts from `@noetic-tools/types` and
resolves codec/library instances from the step or the hydration registry. No
OpenUI code enters core's dependency graph — the same decoupling invariant as
sub-harnesses (`27-sub-harness-steps`), enforced by `.sentrux/rules.toml`
(`core → openui` forbidden, `memory → openui` forbidden).

## Contracts in `types`

### `OutputCodec`

`StepLLM.output` accepts a Zod schema or a codec:

```ts
interface StepLLM<TMemory, _I, O> {
  // ...
  output?: ZodType<O> | OutputCodec<O>;
}

/** A streaming output dialect. Discriminated from ZodType by `kind`. */
interface OutputCodec<O = unknown> {
  kind: 'codec';
  /** Appended to the step's system instructions (e.g. a generated library prompt). */
  instructions?: string;
  /** One session per turn — codecs are stateful while a turn streams. */
  start(): OutputCodecSession<O>;
}

interface OutputCodecSession<O> {
  /** Fed each text delta as it streams. May emit framework events. */
  push(delta: string, emit: (type: string, data: Record<string, unknown>) => void): void;
  /** Called at turn end with the full text. Returns the typed output. */
  finish(fullText: string): O;
}
```

The interpreter's LLM handler feeds the session from the same text-delta stream
it already emits; `finish()` failures surface as the existing structured-output
parse error path. The codec is generic machinery — OpenUI Lang is one dialect.

### `UiFragment` and `ToolUiDeclaration`

OpenUI Lang is a string format, so the tool-side contract carries dialect-tagged
source strings and stays dependency-free:

```ts
/** A renderable UI fragment in a named dialect. */
interface UiFragment {
  dialect: string;   // e.g. 'openui-lang/0.5'
  source: string;    // e.g. 'root = Card([Spinner(), Text("Quoting…")])'
}

interface ToolUiDeclaration<I extends ZodTypeAny, O extends ZodTypeAny, E = unknown> {
  /** Rendered as soon as the call streams in — args may be partial. */
  call?(args: Partial<z.infer<I>>): UiFragment | null;
  /** Re-rendered on each event the tool's AsyncGenerator `execute` yields. */
  progress?(events: E[]): UiFragment | null;
  /** Replaces the region on completion. */
  result?(output: z.infer<O>, args: z.infer<I>): UiFragment | null;
  error?(err: unknown, args: z.infer<I>): UiFragment | null;
}

interface Tool<I, O> {
  // ...existing fields (mirrors `memory?: ToolMemoryDeclaration`)
  ui?: ToolUiDeclaration<I, O>;
}
```

Each render point rides machinery the interpreter already has:

| Render point | Existing hook |
|---|---|
| `call` | the `function_call` item append (partial args while streaming) |
| `progress` | the `event`-schema-validated stream a generator `execute` yields |
| `result` / `error` | the result-item path; fragment attached via `decorateResultItem` / `itemSchemas` so it lives in the item log — durable and replayable |

Fragments are forwarded as `openui.fragment` framework events and attached to
their items; the interpreter never interprets fragment contents.

## The `openUi()` output codec

```ts
import { openUi, createLibrary, defineComponent } from '@noetic-tools/openui';

const lib = createLibrary([defineComponent(/* … */)]);

const dashboard = step.llm({
  id: 'dashboard',
  model: 'claude-sonnet-5',
  tools: [salesTool],
  output: openUi(lib),   // → UiDocument
});
```

`openUi(library)` returns an `OutputCodec<UiDocument>` whose:

- `instructions` is the library-generated system prompt (component signatures,
  enabled feature flags for the OpenUI Lang version in use);
- session incrementally parses line-oriented OpenUI Lang (assignments, `$state`
  declarations, `Query`/`Mutation` bindings, `Action` blocks), emitting
  `openui.node`, `openui.state`, and `openui.query` framework events as each
  statement completes — the transport forwards these to the client for
  progressive rendering;
- `finish()` returns the materialized `UiDocument`.

`Query` and `Mutation` bindings resolve against the step's own `tools` array —
one registry, so data fetches execute as ordinary tool executions with full
`ctx.tokens` / `ctx.cost` / observability coverage and pass through
`beforeToolCall` policy (steering) like any agent-initiated call.

## The `openUiSurface()` memory layer

The layer is the server-side owner of UI state, modeled on `durableTaskState`
(thread-scoped durable state rendered into the View) and `steering`
(enforcement hooks).

```ts
interface OpenUiSurfaceState {
  /** Materialized document — the mounted component tree, tool regions included. */
  document: UiDocument;
  /** Server-side mirror of every $var (two-way bindings included). */
  vars: Record<string, unknown>;
  /** Query results keyed by binding name — part of the durable snapshot. */
  queryCache: Record<string, { value: unknown; fetchedAt: number }>;
  /** Terminal interactions: submitted forms, resolved actions, @ToAssistant sends. */
  interactions: Array<{
    kind: 'submit' | 'action' | 'toAssistant';
    ref: string;
    payload: unknown;
    seq: number;
  }>;
  /** Monotonic version — every mutation (agent render or client event) bumps it. */
  version: number;
  /** Highest client event seq applied — dedupe/ordering on reconnect. */
  appliedEventSeq: number;
}

function openUiSurface(config: { library: UiLibrary }): MemoryLayer<OpenUiSurfaceState>
```

| Property | Value |
|----------|-------|
| **id** | `'openui-surface'` |
| **slot** | `Slot.WORKING_MEMORY + 20` (120) |
| **scope** | `'thread'` |
| **budget** | `{ min: 150, max: 1200 }` |
| **recallMode** | `'atomic'` |
| **rerenderTiming** | `'immediate'` |
| **hooks** | `init`, `onItemAppend`, `recall`, `projectHistory`, `afterModelCall`, `beforeToolCall`, `store`, `onSpawn`, `onReturn`, `onComplete` |

**Behavior:**

- `init`: loads the saved surface from `ScopedStorage` (the durable
  write-through mirror). Thread scope — an `'execution'` scope would rotate the
  key every run and defeat rehydration.
- `onItemAppend`: reduces incoming `ui-event` items (appended by the transport)
  into state — `@Set` on two-way bindings updates `vars`; submits/actions/
  `@ToAssistant` append to `interactions` and bump `version`. Per-keystroke
  `$Set` events update `vars` but are **filtered out of the item pipeline** so
  the item log records semantic interactions, not keystrokes. Requests an
  immediate re-render so the next recall reflects the interaction.
- `recall`: renders a budget-trimmed `<ui_surface>` block — mounted components,
  current `vars`, filled/submitted forms, fresh query results. The raw document
  stays in state; the View gets a summary (same render-and-trim discipline as
  `durableTaskState`).
- `projectHistory`: collapses superseded OpenUI Lang output in history to a
  one-line placeholder (`[rendered ui v3 — superseded]`). The current surface is
  already in the recall block; keeping every prior render verbatim would pay
  its token cost forever.
- `afterModelCall`: folds the turn's parsed assignments into `document`,
  bumps `version`, and validates the emitted document against the registered
  library (unknown component, prop-schema mismatch) — repairing or aborting the
  turn server-side instead of letting the client renderer fail.
- `beforeToolCall`: gates UI-initiated `Mutation` dispatches with the same
  policy surface as agent-initiated calls.
- `store`: persists the surface after every model call (durable write-through).
- `onSpawn`: provides the child a **read-only snapshot** — a child can see the
  UI, not own it. `onReturn`: merges only interactions the child explicitly
  produced. Two writers to one client surface is the conflict `version` exists
  to prevent, so the write direction is conservative.
- `onComplete`: final persist.

### Tool regions

Each tool call owns a reserved, namespaced region of the document: refs under
`tool.<callId>.*`, so programmatic fragments can never collide with
model-authored refs. Lifecycle: `call` mounts the region → each `progress`
patches it → `result`/`error` replaces it — each a `version++` streamed to the
client as ordinary progressive lines. Regions append in document order by
default; a model that wants layout control places an explicit `ToolView(callId)`
slot (a built-in component the package registers in every library) and the
layer mounts the region there instead.

Because fragments attach at the item level, **tool UI works without generative
UI**: an agent whose model emits plain text still gets rich tool cards through
the transport, with no library prompt installed and zero prompt-token cost.

### Interaction loop

`ctx.getLayerState` exposes the surface to predicates, so the interaction loop
is plain composition — no new primitive:

```ts
import { ui } from '@noetic-tools/openui';

const checkout = loop({
  body: step.llm({ id: 'render', model, tools: [quoteShipping], output: openUi(lib) }),
  until: ui.submitted('checkout-form'),   // reads getLayerState(executionId, 'openui-surface')
});
```

The package ships `ui.submitted(ref)`, `ui.interacted(kind?)`, and
`ui.toAssistant()` predicates.

For blocking prompts, the package implements the core ask-user pattern
(`AskUserInput` / `AskUserOutput`, `core/types/ask-user-types.ts` — a portable
interaction shape any renderer can serve): `openUiAskUserService(surface)`
renders the questions as an OpenUI form whose submit resolves the pending
ask-user call. Approval flows (`needsApproval` on a tool) render the tool's
`call` fragment plus approve/deny actions through the same bridge.

## The `fragment()` builder

Raw Lang strings in tool code would be error-prone, so the package compiles a
typed builder from the developer's own library — `createLibrary`'s Zod schemas
already carry the prop types:

```ts
import { fragment } from '@noetic-tools/openui';

const f = fragment(myLibrary);

const quoteShipping = tool({
  name: 'quote_shipping',
  input: QuoteIn, output: QuoteOut, event: QuoteProgress,
  ui: {
    call: (args) => f.Card([f.Spinner(), f.Text(`Quoting ${args.carrier ?? '…'}`)]),
    progress: (ev) => f.Progress(ev.at(-1)?.pct ?? 0),
    result: (out) => f.Table(out.quotes, { columns: ['carrier', 'eta', 'price'] }),
  },
  async *execute(args, ctx) { yield { pct: 40 }; /* … */ return quotes; },
});
```

Constructors compile to `UiFragment` source; typos in component names or prop
shapes fail at typecheck, not in the client renderer.

## The transport (`@noetic-tools/openui/server`)

```ts
import { serveOpenUi } from '@noetic-tools/openui/server';

serveOpenUi(harness, { library: lib, port: 3111 });
```

- Wraps `harness.execute()` in an HTTP/SSE endpoint speaking the message format
  OpenUI's `<AgentInterface>` expects — the package exports the matching
  client-side `noeticStreamAdapter()` / `noeticMessageFormat` for `fetchLLM`.
- Translates the harness's `source: 'sdk'` `response.*` events and the
  `openui.*` framework events into OpenUI's stream protocol (progressive
  line delivery, fragment patches).
- Ingests client events (`@Set`, action runs, submits, `@ToAssistant`) and
  appends them as `ui-event` items into the running execution, carrying the
  document `version` they were rendered against — the layer detects stale
  interactions (the user clicked a control the agent has since re-rendered
  away) via `version` / `appliedEventSeq`.
- On reconnect, answers with the layer-state snapshot
  (`{ document, vars, version }` from `getLayerState`) so a client rehydrates
  from one message instead of replaying the LLM stream.
- Exposes registered tools as the data endpoint OpenUI `Query` / `Mutation`
  bindings call — the same registry the steps use.

The transport is useful standalone: pointing OpenUI's React client at an
existing Noetic agent requires no changes to that agent's steps.

## Event flow

```
agent turn:   step.llm ──deltas──▶ openUi codec ──openui.node/state/query──▶ transport ──▶ client
                                        │
                              afterModelCall: validate + fold into surface, version++
                                        │
                                   store(): durable write-through (thread scope)

tool call:    call fragment ──▶ region mount ──▶ progress patches ──▶ result replace
                                        └─ attached to items via decorateResultItem

client event: <AgentInterface> ──▶ transport ──▶ ui-event item ──▶ onItemAppend:
              reduce into vars/interactions, drop keystroke noise, immediate re-render
                                        │
              next recall(): <ui_surface> block ──▶ model sees current UI
              until/branch predicates: getLayerState(executionId, 'openui-surface')

reconnect:    client ──▶ transport ──▶ {document, vars, version} snapshot ──▶ rehydrate
```

## Future Considerations

- **JSON workflow runtime.** The programmatic surface (the `openUi()` codec,
  the `openUiSurface()` layer, tool `ui` declarations, and the transport) is the
  shipped API. Exposing the codec to the JSON runtime is a follow-up: an `llm`
  node would opt in by reference — `"output": { "codec": "openui", "library":
  "dashboard-lib" }` — with the hydrator resolving the library from a
  `HydrationContext.uiLibraries` registry (the same shape as `subHarnesses`),
  failing with `UNKNOWN_UI_LIBRARY_REFERENCE` on an unregistered name. This
  requires extending `WorkflowDocumentSchema` (an `output` codec variant) plus a
  `bun run gen:schema` regeneration under the drift gate, so it is staged
  separately from the core contract + package work.
- **`step.ui` promotion.** If wizard-style flows make turn-granularity parking
  insufficient, a first-class `step.ui` primitive can hold a checkpointable
  "parked mid-form" position in the graph behind a `UiSurface` contract in
  `types`. The codec, state shape, reducers, and predicates specified here
  transfer into its internals unchanged.
- **Presentation modes.** Tool render functions may grow an options argument
  (`call(args, { mode })`) for condensed-vs-verbose variants; the methods are
  optional and bivariant, so this is additive.
- **Multiple concurrent clients.** Several renderers projecting one surface,
  with per-client cursors over `version`.
- **Dialect evolution.** OpenUI Lang is versioned (`dialect: 'openui-lang/0.5'`);
  the codec and fragment builder pin the version they emit, and the library
  prompt advertises only feature flags that version supports.
