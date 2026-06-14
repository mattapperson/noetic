# 27 — Sub-Harness Steps

Sub-harnesses let a Noetic step delegate a turn to an external coding-agent
runtime — Claude Code, Codex, opencode, pi — exactly the way `step.llm`
delegates a turn to a language model. Each agent is packaged on its own
(`@noetic-tools/sub-harness-<tool>`) and plugs in behind a single contract, so
adding a new agent never touches `@noetic-tools/core`.

## Packages

```
sub-harness-claude-code ─┐
sub-harness-codex ───────┼─→ sub-harness ─→ types
sub-harness-opencode ────┤   (base)
sub-harness-pi ──────────┘
core ─→ types        (core never imports sub-harness or any adapter)
```

- **`@noetic-tools/types`** — defines the `SubHarness` / `SubHarnessSession`
  contract, the `SubHarnessStreamPart` event union (with its Zod schema), the
  `SubHarnessSettings` / `SubHarnessSessionPolicy` shapes, and the
  `SubHarnessKind` discriminant (`'claude-code' | 'codex' | 'opencode' | 'pi'`).
  The contract lives here — next to `MemoryLayer` — so both `core` and the
  adapter packages depend on it without forming a cycle.
- **`@noetic-tools/sub-harness`** — the base package. Re-exports the contract
  and adds `defineSubHarness`, the `SubHarnessTurnAccumulator`, the
  `SubHarnessRegistry`, item builders, the `commonTool` vocabulary, and the
  `SubHarnessCapabilityError` / `SubHarnessStartError` types.
- **`@noetic-tools/sub-harness-<tool>`** — one adapter per agent. Each exports a
  factory (`claudeCode()`, `codex()`, `opencode()`, `pi()`) that returns a
  `SubHarness`. The factory supplies a *runner* (a vendor SDK, loaded as an
  optional peer dependency) to `defineSubHarness`.

## The contract

A `SubHarness` is modelled on Vercel's `HarnessV1`: a tagged spec version, a few
descriptive fields, and one entry point.

```ts
interface SubHarness<TSettings = SubHarnessSettings> {
  readonly specificationVersion: 'harness-v1';
  readonly harnessId: SubHarnessKind;
  readonly builtinTools?: ReadonlyArray<SubHarnessBuiltinTool>;
  readonly lifecycleStateSchema?: z.ZodType;
  doStart(opts: SubHarnessStartOptions<TSettings>): Promise<SubHarnessSession>;
}
```

A `SubHarnessSession` is one workspace + one conversation + one running runtime,
kept across turns by the interpreter. Required methods are `doPromptTurn` and
`doStop`; the rest of the lifecycle is optional and signalled by presence:
`doContinueTurn`, `doSuspendTurn`, `doDetach`, `doDestroy`, `doCompact`. An
adapter that cannot satisfy an optional capability throws
`SubHarnessCapabilityError` from the relevant method rather than advertising a
static capabilities object.

Optional methods absent → the capability is unavailable. This keeps simple
adapters small while letting richer ones grow.

## Stream parts

During a turn the adapter emits a stream of `SubHarnessStreamPart`s
(`stream-start`, `text-delta`, `reasoning-delta`, `tool-call`, `tool-result`,
`file-change`, `finish`, `error`, `raw`). The union has a paired Zod schema so
adapters that move events across a transport boundary can validate them. The
`finish` part carries the turn's `usage` and `cost`.

## Steps

Each agent is a distinct `Step.kind` (`'claude-code'`, `'codex'`, …) with its
own builder, but all share the `StepSubHarness` shape and one interpreter
handler (`executeSubHarness`). The builder takes the adapter inline:

```ts
import { step } from '@noetic-tools/core';
import { claudeCode } from '@noetic-tools/sub-harness-claude-code';

const review = step.claudeCode({
  id: 'review',
  harness: claudeCode({ model: 'claude-opus-4-8', permissionMode: 'plan' }),
  prompt: (ctx) => 'Review the diff and summarize risks',
  output: ReviewSchema, // optional structured output
});
```

`executeSubHarness` mirrors `executeLLM`: it appends the prompt as a user item,
starts (or reuses) a session, drives one `doPromptTurn`, forwards each stream
part as a `sub_harness_event` framework event, appends the turn's items to the
item log, charges `ctx.tokens`/`ctx.cost`, records `ctx.lastStepMeta`, tears the
session down per policy, and returns the assistant text (or the parsed `output`).

### Conversation history

A sub-harness sees the conversation so far, not just its own prompt. Before
appending the turn's prompt, `executeSubHarness` captures the prior items from
`ctx.itemLog` (everything earlier LLM and sub-harness steps produced) and passes
them as `SubHarnessStartOptions.history` when starting a fresh session. So when a
coding agent runs after LLM steps — or on a later turn of a consecutive
`harness.execute()` conversation — it has full context and does not act confused.

History seeds the **first** turn of a fresh session only; after that the
underlying agent owns its own history. A reused session (`session.reuse`) is not
re-seeded. The base `defineSubHarness` hands the history to the runner as
`SubHarnessTurnInput.history`, and the default vendor runners fold it into the
agent's prompt via `withHistoryPrompt`, so the agent literally reads the prior
conversation.

### Output → harness events

Every part a sub-harness emits is mapped onto the harness's observable event
surface so a coding agent's output streams exactly like an LLM step's. The
interpreter's `SubHarnessEventBridge` translates each `SubHarnessStreamPart`
into the same `source: 'sdk'` broadcaster events the model-call path emits:

| Stream part | Mapped `sdk` events |
|-------------|---------------------|
| `stream-start` | `response.created` |
| `text-delta` | `response.output_item.added` (message, once) + `response.output_text.delta` |
| `reasoning-delta` | `response.reasoning.delta` |
| `tool-call` | `response.output_item.added` (function_call) + `response.function_call_arguments.delta`/`.done` + `response.output_item.done` |
| `finish` | closes the open message + `response.completed` |
| `file-change` / `tool-result` / `error` / `raw` | `sub_harness.<type>` (full stream only) |

As a result `getTextStream()`, `getReasoningStream()`, `getItemStream()`, and
`getFullStream()` all surface sub-harness output. The raw part is *also* emitted
as a `sub_harness_event` framework event for harness-native consumers.

**A turn always emits its output.** The bridge brackets every turn with
`response.created` (on `begin()`) and `response.completed` (on `finalize()`), so
even an adapter that streams nothing emits a lifecycle. If an adapter returns a
`SubHarnessTurnResult` without streaming any parts, `finalize()` also synthesizes
the text/tool-call events from the result, so output is never silently swallowed.
`emit: false` on the step suppresses all of it.

Adapters are equally lossless: each `@noetic-tools/sub-harness-*` mapper maps
every vendor message — assistant text → `text-delta`, thinking → `reasoning-delta`,
tool calls → `tool-call` — and falls back to a `raw` part for anything
unrecognized rather than dropping it.

### Session reuse

`session.reuse` keys a live session that survives across steps (stored on the
`AgentHarness`). `session.onComplete` chooses the teardown: `'stop'` (default for
a fresh session) persists and stops the runtime, `'detach'` parks it, `'destroy'`
discards it. A reused session is kept alive by default.

## JSON workflow nodes

The same agents are available in the JSON runtime as four node kinds. A node
names the agent by `kind`; the hydrator resolves the adapter from the workflow's
`HydrationContext.subHarnesses` registry.

```json
{
  "kind": "claude-code",
  "id": "review",
  "prompt": "Review the diff",
  "settings": { "model": "claude-opus-4-8", "permissionMode": "plan" }
}
```

A node with no registered adapter for its `kind` fails hydration with
`UNKNOWN_SUB_HARNESS_REFERENCE`. The published JSON Schema is regenerated from
the Zod source (`bun run gen:schema`).

## Core decoupling invariant

`@noetic-tools/core` imports only the *contract types* from `@noetic-tools/types`
and resolves *adapter instances* from the step (`step.harness`) or the hydration
registry. It never imports `@noetic-tools/sub-harness` or any adapter package, so
no agent SDK enters core's dependency graph. This is enforced by `.sentrux/rules.toml`
boundaries (`core → sub-harness*` forbidden).

## Future Considerations

- Sandbox/bridge-backed adapters (lossless replay across process boundaries) for
  agents that support resuming a turn at an event cursor.
- A `tool-result` round-trip so host-dispatched tool calls can feed results back
  into a running turn.
- Cross-harness built-in tool approvals surfaced through the steering pipeline.
