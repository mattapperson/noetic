# Design Proposal: Multi-Agent Patterns (Item 19)

- **Status:** proposal — design review, no runtime code
- **Source:** fork commit `4cccf95d` (`feat(core): native multi-agent patterns — defineAgent, asTool, handoff, quorum, teammate`, ported from OpenRouter `fa8a9d24`)
- **Plan item:** 19 in `2026-08-12-001-openrouter-fork-upstreaming-plan.md`
- **Constraints:** PR #68 removed `packages/core/src/patterns` and cut naming over; `specs/13-patterns.md` normatively states **core ships no bundled agent patterns**; PR #67 made Standard Schema v1 the schema contract.

## Problem

The fork shipped a bundled multi-agent module (`defineAgent`, `asTool`, `handoff`, `quorum`, `teammate`) inside `@noetic-tools/core`. Upstream policy (#68 + spec 13) forbids exactly this: a pattern baked into the framework fixes its termination rules, context boundaries, and feedback shape, and becomes an obstacle when users need to change one of them. Item 19 is therefore a design decision, not a port: where — if anywhere — does this functionality live? This document inventories what the source actually contains and recommends one of three resolutions: examples/docs, a separate package, or a deliberate policy reversal.

## Source inventory (4cccf95d)

773 lines, one file, zero new runtime machinery — every export compiles to existing primitives:

| Export | Shape | Composed from | Reduces to existing runnable composition? |
|---|---|---|---|
| `defineAgent(def)` | The "agent noun": name/description/model/instructions/tools/context/until/output, compiled once to a reusable `StepLoop` | `loop` + `step.llm` + `any(noToolCalls, maxSteps(10))`, optional `spawn` | Yes — this is the ReAct recipe with a config bag |
| `asTool(agent, opts)` | Agent exposed as a `Tool` (`{task: string}` in, text out); sync via `harness.run`, or `detached: true` via `detachedSpawn` + optional result channel | `tool` + `spawn` + `detachedSpawn` + `channel` | Yes — `sync-delegate.ts` and `async-delegate.ts` already demonstrate both halves |
| `handoff(agents, opts)` | Routing swarm: per-agent `transfer_to_<peer>` tools, active agent swapped via `ctx.state` + `Lazy` model/instructions/tools, shared ItemLog | `loop` + `step.llm` + custom `until` + `prepareNext` | Partially — the `Lazy`-re-resolution trick over `ctx.state` is novel and worth documenting |
| `quorum(agents, {vote})` | Fan-out panel with `majority` / `first` / `all` / `judge` reduction | `fork('settle')` + merge fn; judge = `loop` of fan-out then one judge turn | Mostly — `parallel-research.ts` + `dynamic-judge-workflow.ts` cover fan-out and judge separately |
| `teammate(agent, task, toolCtx)` | Named background worker: detached thread, queue-mode inbox/outbox channels, `send`/`status`/`result` handle, failures surface on outbox | `detachedSpawn` + `spawn` + two `channel`s + inbox-parked `loop` | Partially — `async-delegate.ts` shows detached+inbox; the parked-on-inbox loop and status handle are the delta |

The genuinely reusable deltas over today's examples are: (a) the handoff swarm's per-iteration `Lazy` swap, (b) the teammate's parked inbox loop with a status handle, (c) the judge-vote reducer. Everything else is recipe composition the spec already demonstrates.

## Required adaptation if any code ships

- **Naming cutover (#68):** `step.llm` → `callModel`; `fork({mode:'settle'})` → `inParallel(..., 'settle')`; `frameworkCast` only where genuinely needed. Loop `inbox`/`parkTimeout` and `detachedSpawn` survive unchanged.
- **Standard Schema (#67):** `AgentDef.output?: ZodType` → `StandardSchemaV1<unknown, O>` (spec 02); `tool({input/output})` likewise. The `z.object({task})` internal input schemas can stay Zod (fast path) but the public types must accept any Standard Schema validator — and `defineAgent` must propagate `outputJsonSchema` for validation-only schemas or hit `MISSING_JSON_SCHEMA` at runtime.
- **No `packages/core/src/patterns` directory** under any option except a policy reversal; `.sentrux/rules.toml` and `specs/13-patterns.md` would both need edits in the same commit.

### Naming / CLI collision check

`teammate` collides with an established CLI-domain concept: the Noetic CLI (noetic-internal, spec 22, `packages/web/content/docs/code-agent-cli/`) already uses "teammate" for sub-agent presets spawned via its `agent` tool, with `send_message` / `check_agent` companions, and `spawn.mdx` documents per-teammate session logs. A core export named `teammate()` would shadow that vocabulary at a different layer with different semantics (channel-addressable worker vs. CLI sub-agent preset). If the shape ships, rename to `backgroundAgent()` / `worker()`; keep `teammate` reserved for the CLI domain. `handoff` and `quorum` are collision-free; `asTool` reads fine; `defineAgent` is the most builder-flavored name and the one spec 13's philosophy most objects to (see options).

## Options

### Option A — Examples + docs recipes (recommended)

Port the four shapes as **runnable compositions**: `defineAgent` dissolved back into the ReAct recipe (it is one), plus new examples `handoff-swarm.ts`, `quorum-panel.ts`, `background-agent.ts` under `packages/core/examples/`, and matching rows + prose in `specs/13-patterns.md` ("Runnable Compositions" table). Web docs get a "Multi-agent patterns" guide under `packages/web/content/docs/framework/`.

- **Acceptance criteria:** each example compiles and has a test; spec 13 table updated in the same commit; no new core exports; docs use post-#68 names and Standard Schema.
- **Rejection criteria:** the examples duplicate >100 lines of non-trivial shared logic across copies, or consumers demonstrably need stable cross-version behavior (semver) for the vote reducers/handle semantics — that's the signal for Option B.

### Option B — Separate `@noetic-tools/patterns` package

Ship the compositions as **copy-ready source with tests** (not re-exported builders), per spec 13's own "Future considerations". Depends on `core` only; new `[[layers]]` entry + boundary in `.sentrux/rules.toml`.

- **Acceptance criteria:** Option A's rejection criteria trigger, OR two or more downstream consumers vendor the same recipe. Public surface is small and explicitly recipe-flavored: `reactAgent()`, `handoffSwarm()`, `panel()` (not `quorum`, to avoid implying consensus machinery it doesn't have), `backgroundAgent()`. No `defineAgent` noun — pass plain config objects.
- **Rejection criteria:** the package just re-exports thin wrappers users could paste; publish/maintenance cost exceeds the value; or it drifts into fixing termination/context policy per user (spec 13's original objection).

### Option C — Policy reversal: restore bundled patterns in core

Re-add `packages/core/src/patterns/agents.ts` behind `@public` exports, edit spec 13 and `.sentrux/rules.toml` in the same commit.

- **Acceptance criteria (all required):** written rationale superseding spec 13's "patterns are compositions" argument; maintainer sign-off that core's API surface should grow by 5 exports + 3 types; a demonstrated consumer that cannot use examples or a side package.
- **Rejection criteria:** any of the above missing. On current evidence none are met — this option exists to make the rejection explicit and documented, which the plan (line 162) already sanctions as an acceptable outcome.

## Recommendation

**Option A now, Option B as a triggered evolution, reject C on the record.** The source commit itself is the proof: 773 lines composing only builders, with no interpreter/runtime change — which is spec 13's thesis. The novel deltas (Lazy handoff swap, parked-inbox teammate, judge reducer) are exactly the kind of thing runnable examples teach better than frozen builders.

## Concrete API alternatives (if B ever triggers)

```ts
// @noetic-tools/patterns — recipes, not builders; Standard Schema throughout
import { callModel, inParallel, loop, spawn, until } from '@noetic-tools/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';

reactAgent({ model, instructions, tools, maxSteps?, maxCost?, context? });      // = today's ReAct recipe
handoffSwarm(agents: AgentConfig[], { entry?, until?, maxIterations? });        // Lazy swap over ctx.state
panel(agents: AgentConfig[], { vote: 'majority' | 'first' | 'all' | { judge } });
backgroundAgent(agent: AgentConfig, task, toolCtx): { send, status, result, outbox };

interface AgentConfig {
  name: string;                                  // tool-name-safe
  description?: string;
  model: Lazy<string>;
  instructions?: Lazy<string | undefined>;
  tools?: Tool[];
  context?: ContextConfig | ContextLayer[];
  output?: StandardSchemaV1<unknown, unknown>;   // + outputJsonSchema for validation-only schemas
}
```

Note what is absent vs. the fork: no `Agent` wrapper type, no memoized `agent.step`, no `defineAgent`. The recipe takes config and returns a `Step`; the user owns the noun.

## Implications for item 20 (declarative multi-agent nodes)

Item 20 (JSON workflow nodes for multi-agent shapes) is blocked on this decision because a JSON node must hydrate against a **registered, versioned API** — examples cannot be hydration targets.

- **Option A (chosen):** item 20 is deferred or redesigned. A JSON `handoff`/`quorum` node has nothing stable to hydrate to; the honest resolution is to extend the JSON schema's existing node set only when/if Option B lands. This matches plan line 162 ("item 20 is then deferred or redesigned rather than forced through").
- **Option B (if triggered later):** item 20 unblocks cleanly — add `handoff`/`panel`/`background-agent` node types whose hydrator resolves against `@noetic-tools/patterns` via the registry seam from item 14, regenerating both `noetic-workflow.schema.json` artifacts (`bun run gen:schema`) and inspector glyphs in the same commit.
- **Option C:** same as B but against core; rejected for the reasons above.

## Decision requested

Approve Option A and record the rejection of Option C, or direct Option B with the naming adjustments above.
