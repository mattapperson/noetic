# 12a — CLI-Specific Memory Layers

> **Depends On:** `11-memory-layer-system` (Slot, MemoryLayer, hooks), `12-builtin-memory-layers` (base built-ins)
> **Status:** Stable

This spec documents memory layers shipped with `@noetic-tools/cli` that are not part of the core framework. They compose on top of the base layers defined in `12-builtin-memory-layers.md`.

---

## `reminderLayer(opts)`

**Slot:** `Slot.REMINDER` (80)
**Scope:** `'execution'`
**Budget:** `{ min: 0, max: 800 }`

Injects `<system-reminder>`-wrapped developer messages into the conversation based on turn-count throttling and state detection. Patterned after Claude Code's `wrapInSystemReminder` attachment pipeline.

### Factory

```typescript
reminderLayer(opts: { registry: ReminderRegistry }): MemoryLayer<ReminderLayerState>
```

### State

```typescript
interface ReminderLayerState {
  assistantTurnCount: number;
  firedHistory: Map<string, { triggerId: string; assistantTurn: number }>;
  toolUsageCounts: Map<string, number>;
  recentToolNames: string[];
  consecutiveErrorCount: number;
}
```

### Trigger contract

```typescript
interface ReminderTrigger {
  id: string;                                   // unique; duplicate register() throws
  minTurnsBetweenReminders: number;             // dual-counter throttle
  timing: 'recall' | 'immediate';               // recall = next turn; immediate = onItemAppend
  shouldFire(tc: ReminderTriggerContext): string | null;
}

interface ReminderRegistry {
  register(trigger: ReminderTrigger): void;
  list(): ReadonlyArray<ReminderTrigger>;
}
```

Triggers with `timing: 'recall'` are invoked during `recall()` — their output rides the next turn's assembly. Triggers with `timing: 'immediate'` are invoked during `onItemAppend()` and inject developer items alongside the incoming items (typically tool outputs).

Throttling: a trigger fires only when `assistantTurnCount - firedHistory[id].assistantTurn >= minTurnsBetweenReminders`.

### Built-in triggers (shipped in `BUILTIN_TRIGGERS`)

| id | timing | fires when |
|----|--------|-----------|
| `agent-md-loaded` | recall | turn 0, if `agent-md` layer has sources |
| `plan-mode-still-active` | recall | every 8 turns while `plan-memory.session.mode === 'planning'` |
| `long-conversation` | recall | every 40 assistant turns |
| `error-recovery` | immediate | after 3 consecutive error-looking tool outputs |
| `consecutive-bash` | recall | after 3 Bash calls in a row |

### Cross-layer coordination

Triggers read sibling layer state via `ctx.readLayerState<T>(layerId)` (see spec 11 §ExecutionContext). The shape of sibling state is the other layer's responsibility; triggers should typeguard the result.

### Observability

Each fired reminder is an `InputMessageItem` with `role: 'developer'` and content wrapped in `<system-reminder>…</system-reminder>`. The harness treats it as a normal developer message for token accounting and logging purposes.

---

## `agentMdLayer(opts)`

**Slot:** `Slot.OBSERVATIONS - 5` (195)
**Scope:** `'execution'`
**Budget:** `{ min: 0, max: 15_000 }`

Surfaces the merged output of the AGENT.md + rules loader (`packages/cli/src/config/agent-md-loader.ts`). Runs the loader once in `init()` and renders the cached result in `recall()`.

### Factory

```typescript
agentMdLayer(opts: { loader: () => Promise<AgentInstructionResult> }): MemoryLayer<AgentInstructionResult>
```

### Rendered format

```
# Project & User Instructions (AGENT.md)

Contents of ./AGENT.md (project instructions, checked into the codebase):

<body — with @imports inlined>

Contents of ./.agent/rules/testing.md (project instructions, checked into the codebase):

<body>

Contents of ~/.config/noetic/AGENT.md (user's private global instructions for all projects):

<body — with @imports inlined>
```

If the loader reports `totalCapExceeded: true` (sources dropped to stay under the 60KB total cap), a trailing note is appended.

### Discovery order

See `packages/cli/src/config/agent-md-loader.ts` for the authoritative list. Summary:

1. `./AGENT.md`
2. `./.agent/AGENT.md`
3. `./.agent/rules/*.md` (sorted)
4. Ancestor AGENT.md files from cwd up to the enclosing repo root
5. `~/.config/noetic/AGENT.md`
6. `~/.config/noetic/rules/*.md` (sorted)
7. `~/.noetic/AGENT.md`
8. `~/.noetic/rules/*.md` (sorted)

### Per-source processing

Each discovered file is processed in three passes:
1. **`@import` resolution** — lines matching `^@(\S+\.md)\s*$` are transcluded inline. Cycle-safe (visited set) and depth-limited (5).
2. **Embedded `!command` execution** — via `processSkillContent` (reused from `packages/cli/src/skills/processor.ts`). User-origin files execute by default; project-origin files require `config.trustProjectEmbeddedCommands: true`.
3. **Truncation** — 200 lines / 25KB per file, 60KB total. Lowest-precedence sources drop first.

### Security

Embedded commands are a supply-chain risk for project-origin files (any contributor could add a `!curl | sh` line). The default (`trustProjectEmbeddedCommands: false`) leaves the command text intact but skips execution, tagging the line with an HTML comment explaining why.

---

## Interaction with core layers

The reminder layer and agent-md layer are registered in `packages/cli/src/harness/factory.ts` alongside the existing core layers. Canonical slot ordering in the CLI:

| Slot | Layer |
|------|-------|
| 80 (REMINDER) | `reminder` |
| 90 (STEERING) | `plan-memory` |
| 100 (WORKING_MEMORY) | `working-memory` |
| 195 | `agent-md` |
| 200 (OBSERVATIONS) | `observational-memory` |
| 250+ | `file-reference`, `durable-task-state`, tool-memory layers, plugin layers, `skills` |

The reminder layer fires before steering so its developer messages are visible in the turn assembly; the agent-md layer sits just ahead of observations so project/user instructions establish context before runtime observations.
