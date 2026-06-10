# Built-In Memory Layers

> **Module:** `@noetic-tools/memory` (source at `packages/memory/src/memory/layers/**`); re-exported by `@noetic-tools/core`.
> **Depends On:** `11-memory-layer-system` (MemoryLayer, MemoryHooks, Slot, ScopedStorage, BudgetConfig, all hook param types)
> **Exports:** `workingMemory()`, `semanticRecall()`, `observationalMemory()`, `temporalMemory()`, `episodicMemory()`, `durableTaskState()`, `steering()`, `planMemory()`, `WorkingMemoryConfig`, `SemanticRecallConfig`, `ObservationalMemoryConfig`, `TemporalMemoryConfig`, `TemporalFact`, `TemporalSearchResult`, `FactExtractor`, `FactSearcher`, `EpisodicMemoryConfig`, `DurableTaskState`, `SteeringConfig`, `SteeringRule`, `PlanMemoryConfig`, `PlanState`, `PlanPhase`, `PlanExecutionEntry`, `VectorStore`, `Embedder`, `EpisodicStore`, `DocumentRetriever`, `Reranker`, `PubSubChannel`

---

These are informative reference implementations. They are NOT special-cased in the runtime — they use the same `MemoryLayer` interface as custom layers.

All layers return `Item[]` from `recall` — each block is a `MessageItem` with `role: developer` (framework-injected context, distinct from user-authored `system` instructions).

---

## `workingMemory()`

Always-available structured or freeform state, injected near the top of the View.

```typescript
interface WorkingMemoryConfig {
  scope?: 'thread' | 'resource';
  schema?: ZodType;
  template?: string;
  readOnly?: boolean;
}

function workingMemory(config?: WorkingMemoryConfig): MemoryLayer<WorkingMemoryState>
```

| Property | Value |
|----------|-------|
| **id** | `'working-memory'` |
| **slot** | `Slot.WORKING_MEMORY` (100) |
| **scope** | `config.scope ?? 'thread'` |
| **budget** | `{ min: 200, max: 1500 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

**Behavior:**
- `init`: Loads state from `ScopedStorage`. Defaults to `{}` (schema) or `''` (freeform). Persisted state that fails the configured schema falls back to `{}` (corrupt state must not abort the execution).
- `recall`: Renders state as `<working_memory>` block in a `MessageItem` with `role: developer`. Returns `null` if empty.
- `store`: Watches for `FunctionCallItem` with `name: 'updateWorkingMemory'`. Deep-merges structured state (object-valued keys merge recursively; arrays and primitives replace). When a schema is configured, the **merged** state is validated (partial updates stay legal); a violating merge throws — the runtime logs a diagnostic and drops the update, leaving prior state untouched.
- `onSpawn`: Clones state for `scope: 'resource'`. Returns `null` otherwise.

**Provides:**

Working memory exposes two declarations via its `provides` map, making state available to code steps and LLM tool calls:

| Name | Kind | Description |
|------|------|-------------|
| `snapshot` | `layerData` | Returns the current working memory state as-is. |
| `update` | `layerFn` | Merges new key-value pairs into the state. Exposed as `working-memory/update` LLM tool. |

```typescript
provides: {
  snapshot: layerData({ read: (state) => state }),
  update: layerFn({
    description: 'Update the agent working memory with new key-value pairs.',
    input: z.record(z.string(), z.unknown()),
    output: z.void(),
    // Deep-merges args into state recursively (objects merge, arrays/primitives
    // replace). __proto__ / constructor are stripped at every depth.
    execute: async (args, state) => ({ result: undefined, state: deepMerge(state, args) }),
  }),
}
```

- **`snapshot`** — A data declaration. Code steps access it synchronously via `ctx.memory['working-memory'].snapshot`, which returns the full `WorkingMemoryState`.
- **`update`** — A function declaration. Code steps call it as `await ctx.memory['working-memory'].update({ key: 'val' })`. The runtime also exposes it as an LLM tool named `working-memory/update`, allowing the model to update working memory through the standard tool-call mechanism. When a `schema` is configured, the merged state is validated; a violating update throws, surfacing as a tool error the model can see, and the state is unchanged.
- **Deep merge:** Updates merge recursively — nested object keys are deep-merged rather than overwritten; arrays and primitives replace. When the prior state is a freeform **string** and an object update arrives, the prior string is preserved under a `_previous` key instead of being silently discarded.
- **Prototype poisoning protection:** The merge strips `__proto__` and `constructor` keys from incoming arguments at every depth.
- **Backward compatibility:** The `store` hook still detects `findFunctionCall(newItems, 'updateWorkingMemory')` for LLMs that emit the legacy function-call convention. Both paths apply the same prototype-stripping and merge logic.
- **Type-safe access:** The `workingMemory()` factory returns its result `satisfies MemoryLayer<WorkingMemoryState>`, preserving the literal layer id and provides shape at the type level. Combine `memory([workingMemory()])` with `InferMemory<typeof mem>` to get compile-time typed access to `ctx.memory['working-memory']`.

---

## `semanticRecall()`

Vector-search over past items, injected for relevant context.

```typescript
interface SemanticRecallConfig {
  vectorStore: VectorStore;
  embedder: Embedder;
  topK?: number;
  contextWindow?: number | { before: number; after: number };
  minScore?: number;
  scope?: 'thread' | 'resource' | 'global';
}

function semanticRecall(config: SemanticRecallConfig): MemoryLayer<void>
```

| Property | Value |
|----------|-------|
| **id** | `'semantic-recall'` |
| **slot** | `Slot.SEMANTIC_RECALL` (400) |
| **scope** | `config.scope ?? 'resource'` |
| **budget** | `{ min: 0, max: 4000 }` |
| **hooks** | `recall`, `store` |

**Behavior:**
- `recall`: Embeds query, searches vector store, expands with context window, trims to budget. Returns `<semantic_recall>` block in a `MessageItem` with `role: developer`.
- `store`: Embeds items where `item.type === 'message'` and upserts to vector store.

### Supporting Types

```typescript
interface VectorStore {
  search(embedding: number[], opts: { topK: number; filter: unknown; minScore: number }): Promise<VectorResult[]>;
  upsert(entry: { id: string; embedding: number[]; metadata: unknown }): Promise<void>;
}

interface Embedder {
  embed(text: string): Promise<number[]>;
}
```

---

## `observationalMemory()`

Distills conversation into concise observations using a background LLM call.

```typescript
interface ObservationalMemoryConfig {
  bufferThreshold?: number;    // tokens before observer runs, default 2000
  maxObservations?: number;    // max kept, default 50 (compaction beyond)
  observerModel?: string;      // default: haiku
  observerPrompt?: string;
  scope?: 'thread' | 'resource';
}

function observationalMemory(config?: ObservationalMemoryConfig): MemoryLayer<ObservationalState>
```

| Property | Value |
|----------|-------|
| **id** | `'observational-memory'` |
| **slot** | `Slot.OBSERVATIONS` (200) |
| **scope** | `config.scope ?? 'resource'` |
| **budget** | `{ min: 500, max: 2500 }` |
| **timeouts** | `{ store: 60_000, onItemAppend: 60_000 }` (both hooks run the LLM-backed distillation path) |
| **hooks** | `init`, `recall`, `store`, `onItemAppend`, `onSpawn` |

**Behavior:**
- `init`: Loads versioned state from storage.
- `recall`: Renders observations as `<observations>` bullet list in a `MessageItem` with `role: developer`. Trims output to the allocated budget.
- `store`: Buffers **assistant output** items. When the token threshold is reached, runs the observer LLM on the buffer. Compacts if over `maxObservations`.
- `onItemAppend`: Buffers **user input and tool output** items the same way `store` buffers assistant output, so observations are distilled from the full conversation, not just the model's replies.
- `onSpawn`: Clones observations to child.

---

## `temporalMemory()`

Non-atomic, LLM-backed long-term memory for time-anchored recall. Distills the conversation into a key-value ledger of timestamped facts and answers temporal queries on demand. Addresses the failure class that pure recall cannot fix: relative-date arithmetic and event ordering ("what did I do three weeks ago?").

```typescript
interface TemporalFact { ts: string; fact: string }        // ts = ISO-8601

interface TemporalSearchResult {
  facts: string[];
  date?: string;        // resolved date when the query implies one
  fuzzy?: boolean;      // true when the date is approximate
}

// Host-injected LLM capabilities (keep the layer tree-shakable / LLM-agnostic)
type FactExtractor = (input: { transcript: string; now: string }) => Promise<TemporalFact[]>;
type FactSearcher = (input: { query: string; facts: TemporalFact[]; now: string }) => Promise<TemporalSearchResult>;

interface TemporalMemoryConfig {
  now?: () => Date;            // injectable clock (tests/replay); default () => new Date()
  scope?: 'thread' | 'resource';
  extract?: FactExtractor;     // store-side distillation; omitted → buffer only, never fabricate
  search?: FactSearcher;       // searchMemory backing; omitted → tool returns the raw ledger
  bufferThreshold?: number;    // tokens before extract runs, default 2000
  maxFacts?: number;           // ledger cap, default 200 (oldest timestamps dropped)
  groundDateTime?: boolean;    // inject <current_datetime> on recall, default true
  injectLedger?: boolean;      // also inject <remembered_facts> on recall, default false
}

function temporalMemory(config?: TemporalMemoryConfig): MemoryLayer<TemporalState>
```

| Property | Value |
|----------|-------|
| **id** | `'temporal'` |
| **slot** | `Slot.REMINDER` (80) |
| **scope** | `config.scope ?? 'resource'` |
| **budget** | `{ min: 0, max: config.injectLedger ? 800 : 200 }` |
| **timeouts** | `{ store: 60_000, onItemAppend: 60_000 }` (both hooks run the LLM-backed extraction path) |
| **hooks** | `init`, `recall`, `store`, `onItemAppend`, `onSpawn` |

**State:** `{ facts: Record<isoTs, string[]>, buffer: string[], bufferTokens: number, version: number }`.

**Behavior:**
- `init`: Loads versioned state from `ScopedStorage`. Defaults to an empty ledger.
- `recall`: When `groundDateTime`, emits a `<current_datetime>` block so the model can resolve relative time and compute date differences (deterministic — no LLM call). When `injectLedger`, also emits a `<remembered_facts>` block trimmed to the allocated budget. Returns `null` when both are off/empty.
- `store`: Buffers text from **assistant output** items. Once `bufferTokens >= bufferThreshold` and an `extract` callback is configured, calls `extract({ transcript, now })`, merges the returned facts into the ledger keyed by ISO timestamp, caps to `maxFacts`, clears the buffer, and bumps `version`. With no `extract`, it keeps buffering — it never invents facts.
- `onItemAppend`: Buffers **user input and tool output** items into the same buffer, so facts are extracted from the full conversation rather than only the model's replies.
- `onSpawn`: Deep-clones state to the child execution.

**Ledger cap (fact granularity):** `maxFacts` is enforced per *fact*, not per timestamp. When the ledger exceeds `maxFacts`, facts are flattened chronologically and only the newest `maxFacts` are kept — so a single oversized extraction at one instant cannot evict the just-added newest facts.

**Provides:**

| Name | Kind | Description |
|------|------|-------------|
| `searchMemory` | `layerFn` | Given `{ query }`, returns `TemporalSearchResult`. Exposed as the `temporal/searchMemory` LLM tool. Delegates to the injected `search` callback; without one, returns the raw `[ts] fact` ledger so the tool degrades gracefully. |

**Design:** The layer is LLM-agnostic — `extract`/`search` are injected by the host (mirroring `observationalMemory`'s `observer`), so `memory/` stays tree-shakable. The code agent wires structured `step.llm` calls as the callbacks and installs `temporalMemory()` in its default stack.

---

## `episodicMemory()`

Records execution summaries and retrieves relevant past experiences.

```typescript
interface EpisodicMemoryConfig {
  store: EpisodicStore;
  embedder: Embedder;
  retrieval?: 'embedding' | 'recency' | 'both';
  maxEpisodes?: number;
  scope?: 'resource' | 'global';
}

function episodicMemory(config: EpisodicMemoryConfig): MemoryLayer<void>
```

| Property | Value |
|----------|-------|
| **id** | `'episodic-memory'` |
| **slot** | `Slot.EPISODIC` (300) |
| **scope** | `config.scope ?? 'resource'` |
| **budget** | `{ min: 0, max: 2000 }` |
| **hooks** | `recall`, `onComplete` |

**Behavior:**
- `recall`: Retrieves by embedding similarity, recency, or both. Deduplicates. Returns `<past_experiences>` block in a `MessageItem` with `role: developer`.
- `onComplete`: Creates episode summary, embeds it, saves to store.

### Supporting Types

```typescript
interface EpisodicStore {
  searchByEmbedding(embedding: number[], opts: unknown): Promise<Episode[]>;
  getRecent(opts: unknown): Promise<Episode[]>;
  save(episode: Episode, embedding: number[]): Promise<void>;
}

interface Episode {
  id: string;
  summary: string;
  timestamp: number;
  outcome: ExecutionOutcome;
}
```

---

## `durableTaskState()`

Persists task-level artifacts (files modified, progress checkpoints, arbitrary data) across spawn boundaries and across executions within a thread. This replaces a standalone `Persistence` interface — all state that survives across fresh-context iterations is managed uniformly through memory layers.

```typescript
interface DurableTaskState {
  checkpoints: Array<{ timestamp: number; depth: number }>;
  files: string[];
  data: Record<string, unknown>;
}

function durableTaskState(): MemoryLayer<DurableTaskState>
```

| Property | Value |
|----------|-------|
| **id** | `'durable-task-state'` |
| **slot** | `Slot.WORKING_MEMORY + 10` (110) |
| **scope** | `'thread'` |
| **budget** | `{ min: 100, max: 800 }` |
| **timeouts** | `{ store: 30_000 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn`, `onReturn`, `onComplete` |

**Behavior:**
- `init`: Loads saved state from `ScopedStorage` (written by the runtime's durable write-through mirror; see spec 11 *Durable Persistence*). Defaults to an empty state.
- `recall`: Renders the state as a `<task_state>` block in a `MessageItem` with `role: developer`, trimmed to the allocated budget — the oldest checkpoints are halved away while the render exceeds the budget, with a final closing-tag-preserving char-slice guard. A zero budget is fail-open (full render).
- `store`: Appends a `{ timestamp, depth }` checkpoint per model call, capped at the newest **50** checkpoints.
- `onSpawn`: **Always** provides child state (unlike other layers that may return `null`).
- `onReturn`: Merges child files/checkpoints/data back into parent (checkpoints capped at 50 after the merge, newest kept).
- `onComplete`: Final checkpoint with outcome label (capped).

**Key design:** Scope is `'thread'` so the state persists across executions/iterations within the same thread (an `'execution'` scope would rotate its key every run and defeat durable rehydration). Always crosses spawn boundaries. Recalls into the View so the LLM can see progress.

---

## `steering()`

Enforces behavioral rules at execution time — before tool calls and after model responses. Rules can be declared programmatically (static string checks) or evaluated by a secondary LLM call.

```typescript
interface SteeringRule {
  id: string;
  description: string;
  /**
   * Programmatic check. Return a violation message string to block, or null/undefined to pass.
   * When omitted, the rule is evaluated by an LLM call via the execution context's harness.
   */
  check?: (toolName: string, toolArgs: unknown) => string | null | undefined;
  /** Which hook to apply this rule in. Default: 'beforeToolCall'. */
  hook?: 'beforeToolCall' | 'afterModelCall';
}

interface SteeringConfig {
  rules: SteeringRule[];
  /** Model to use for LLM-evaluated rules. Defaults to the harness's configured model. */
  model?: string;
  /** Max entries retained in the per-execution violation ledger. Default: 100. */
  maxLedgerEntries?: number;
  /** Max retries on unparseable LLM verdicts before treating as pass. Default: 1. */
  maxRetries?: number;
}

function steering(config: SteeringConfig): MemoryLayer<SteeringState>
```

| Property | Value |
|----------|-------|
| **id** | `'steering'` |
| **slot** | `Slot.STEERING` (90) |
| **scope** | `'execution'` |
| **budget** | none (this layer does not participate in `recall`) |
| **hooks** | `beforeToolCall`, `afterModelCall` |

**Behavior:**

- `beforeToolCall`: Runs each rule whose `hook` is `'beforeToolCall'` (the default). Programmatic rules call `check(toolName, toolArgs)`. LLM-evaluated rules send a prompt to the LLM (via `ctx.harness`) with the rule description and the pending call; a violation response blocks the tool. If any rule returns a violation, tool execution is blocked and the violation message is surfaced as a tool error. The violation is recorded in the in-memory ledger.
- `afterModelCall`: Runs each rule whose `hook` is `'afterModelCall'`. LLM-evaluated rules receive the full model response text. A violation aborts the current turn with the violation message.
- **Ledger**: Each execution maintains a bounded log of `{ ruleId, hook, toolName?, violation, timestamp }` entries. Capped at `maxLedgerEntries`. Accessible via `getLayerState(executionId, 'steering')`.
- **LLM evaluation**: When a rule has no programmatic `check`, the layer sends a structured prompt — the rule description, the tool name and serialized args (for `beforeToolCall`) or the model output (for `afterModelCall`) — and asks the model to reply with exactly `ALLOW`, `DENY`, or `GUIDE: <guidance text>`. The verdict is parsed by matching one of those keywords at the start of the response on a **word boundary** (so `DENYALL` is not a `DENY`), **case-insensitively**, while the guidance text after `DENY`/`GUIDE` is preserved verbatim (original casing). Unparseable output is retried up to `maxRetries`; on exhaustion the rule is treated as a pass (`ALLOW`). If no LLM provider is configured (no `callModel` on the execution context), LLM-evaluated rules throw a `NoeticConfigError` with code `MISSING_CALL_MODEL` — a fail-closed design to prevent silent bypass of security rules.
- **Async rules**: Rules evaluated in async mode do not block the hook; non-Allow verdicts are queued and injected as a `<steering_feedback>` block by `recall` on the **next recall after the verdict resolves** — each verdict is delivered exactly once. The pending-feedback queue is drained in place, so a verdict resolving mid-turn is never lost; it simply surfaces one recall later.
- **Slot 90**: Runs before all other layers (slot 100+) in `beforeToolCall` and `afterModelCall` to ensure policy enforcement precedes any side effects.

```typescript
// Programmatic rule example
steering({
  rules: [
    {
      id: 'no-delete',
      description: 'Prevent deletion of files outside the workspace.',
      check: (toolName, toolArgs) => {
        if (toolName !== 'deleteFile') return null;
        const args = toolArgs as { path: string };
        if (!args.path.startsWith('/workspace/')) return 'Deletion outside /workspace/ is not allowed.';
        return null;
      },
    },
  ],
});

// LLM-evaluated rule example (gets LLM client from ctx.harness internally)
steering({
  rules: [
    {
      id: 'no-pii',
      description: 'Model output must not contain personally identifiable information.',
      hook: 'afterModelCall',
    },
  ],
});
```

---

## `historyWindow()`

Caps the trailing items projected to the LLM on every turn. Slot `275` (after recall-contributing layers), scope `'execution'`. Hooks: `init` (returns `null` state) and `projectHistory`.

```typescript
function historyWindow(config?: { maxItems?: number }): MemoryLayer<null>
```

**Default**: `maxItems = 40` (validated to an integer in `[2, 10000]`).

**Algorithm per LLM call**:
1. Slice `items.slice(-maxItems)`.
2. If the slice lacks a user `message` or an assistant `message`, expand backward until both are present (minimum-exchange guarantee). This expansion is **bounded**: it may exceed `maxItems` only up to a hard cap of `maxItems × 4`, so a tool-only burst (many `function_call`/`function_call_output` items with no role messages) cannot grow the window back to the start of history. Excess beyond the cap drops the oldest items.
3. **Re-attach a head system/anchor message.** If a `system` message in the leading items fell outside the window, it is prepended so core instructions survive windowing (only the first few leading items are scanned).
4. Run `stripUnresolvedToolCalls(window)` to drop any orphan `function_call` / `function_call_output` left at the slice boundary.

**Storage isolation**: this layer never mutates `itemLog`, `accumulatedItems`, or session JSON. Session save/restore, `getAgentResponse`, and TUI transcript views remain whole. The cap is purely a read-side projection over the value handed to `assembleView`.

**Mid-round flow is uncapped**: within a single `callModel` invocation's tool loop, that round's own `function_call` / `function_call_output` items keep accumulating in `conversationInput`. The cap fires at turn boundaries, not mid-call — the in-flight tool loop is intentionally preserved.

The CLI exposes the cap via `AgentConfig.history.maxItems`. When unset, the layer is not installed and history is uncapped.

```typescript
// Direct usage in core
const memory = [
  workingMemory(),
  observationalMemory(),
  historyWindow({ maxItems: 40 }),
];
```

---

## Custom Layer Examples (Informative)

### RAG Knowledge Base

```typescript
function ragMemory(config: {
  retriever: DocumentRetriever;
  maxChunks: number;
  reranker?: Reranker;
}): MemoryLayer<void>
```

Slot `Slot.RAG` (350), scope `'global'`, budget `{ min: 0, max: 6000 }`. Recall-only — searches, optionally re-ranks, trims to budget.

### Entity Graph

```typescript
function entityMemory(config: { extractorModel?: string }): MemoryLayer<EntityGraphState>
```

Slot `Slot.ENTITY` (150), scope `'resource'`. Extracts entities from new items in `store`, renders relevant entities in `recall`.

### Shared Swarm Memory

```typescript
function sharedSwarmMemory(config: { channel: PubSubChannel }): MemoryLayer<SwarmState>
```

Slot `380`, scope `'execution'`. Subscribes to peer findings in `init`, drains in `recall`, publishes in `store`, cleans up in `dispose`. Uses `onSpawn`/`onReturn` for parent-child finding merge.

---

## `planMemory()`

Manages the full plan lifecycle: entering plan mode, authoring a PRD, structuring an execution tree, and tracking execution outcomes.

```typescript
interface PlanMemoryConfig {
  scope?: MemoryScope;
  additionalAllowedTools?: string[];
  maxPrdLength?: number;
  maxTreeDepth?: number;
}

function planMemory(config?: PlanMemoryConfig): MemoryLayer<PlanState>
```

| Property | Value |
|----------|-------|
| **id** | `'plan'` |
| **slot** | `Slot.PROCEDURAL - 10` (240) |
| **scope** | `config.scope ?? 'thread'` |
| **budget** | `{ min: 100, max: 3000 }` |
| **hooks** | `init`, `recall`, `beforeToolCall`, `onSpawn`, `onComplete` |

**State:**

```typescript
type PlanPhase = 'idle' | 'planning' | 'executing' | 'completed' | 'failed';

interface PlanState {
  phase: PlanPhase;
  prd: string | null;
  planTree: PlanNode | null;
  executionLog: PlanExecutionEntry[];
  version: number;
}
```

**Behavior:**
- `init`: Loads persisted `PlanState` from `ScopedStorage`. Defaults to idle with null PRD/tree.
- `recall`: Phase-dependent context injection. Returns `null` in idle. In `planning`, renders `<plan_mode>` block with instructions and draft PRD. In `executing`, renders `<active_plan>` block with PRD and plan tree. In terminal phases, renders `<plan_outcome>` summary.
- `beforeToolCall`: In `planning` phase, restricts tools to read-only (`Read`, `Grep`, `Find`, `Ls`) plus plan layer tools and `activateSkill`. Denies mutating tools (`Write`, `Edit`, `Bash`). No restrictions outside planning phase.
- `onSpawn`: Deep-clones state to child execution.
- `onComplete`: If `executing`, records outcome in `executionLog` and transitions to `completed` or `failed`. State is returned to the runtime for persistence.

**Provides:**

| Name | Kind | Description |
|------|------|-------------|
| `status` | `layerData` | Read-only projection: `{ phase, hasPrd, hasPlanTree, version }`. |
| `enterPlanMode` | `layerFn` | Transitions idle → planning. Accepts optional `goal` string to seed the PRD. |
| `updatePrd` | `layerFn` | Replaces the PRD content. Only works in planning phase. Validates max length. |
| `setPlanTree` | `layerFn` | Sets the `PlanNode` execution tree. Validates against `PlanNodeSchema` and max depth. |
| `exitPlanMode` | `layerFn` | Exits plan mode. `action: 'execute'` validates PRD + tree exist and transitions to executing. `action: 'cancel'` resets to idle. |

**Integration with `compilePlan`/`adaptivePlan`:** The plan layer stores the `PlanNode` tree produced by the LLM. Advanced users can extract the tree from `status` and pass it to `compilePlan()` for programmatic execution. The default CLI flow uses context injection — the plan is recalled into the LLM's view and the model executes by making tool calls.

---

## CLI-Specific Layers (`packages/cli`)

The CLI package (`packages/cli/src/memory/`) provides several memory layers built on the `@noetic-tools/memory` interface. These implement prompt engineering patterns adapted from Claude Code's system:

| Layer | Source | Purpose |
|-------|--------|---------|
| `promptEngineeringLayer()` | `packages/cli/src/memory/prompt-engineering-layer.ts` | Core behavioral guidelines, tool usage tracking, error-based adaptation |
| `communicationStyleLayer()` | `packages/cli/src/memory/communication-style-layer.ts` | Adaptive communication patterns (concise/normal/verbose) based on user message analysis |
| `environmentContextLayer(config)` | `packages/cli/src/memory/environment-context-layer.ts` | Dynamic environment detection (platform, git, Node.js, shell, package manager) |
| `toolGuidanceLayer(config)` | `packages/cli/src/memory/tool-guidance-layer.ts` | Context-aware tool preference hierarchy and mode-specific guidance |
| `planningModeLayer(config)` | `packages/cli/src/memory/planning-mode-layer.ts` | Plan-mode instructions with FlowSchema types, PRD authoring, phase tracking |
| `skillsLayer(definitions, config)` | `@noetic-tools/code-agent` (`packages/code-agent/src/memory/skills-layer.ts`), re-exported via `packages/cli/src/memory/skills-layer.ts` | Progressive skill disclosure with inline command processing |

These layers all use `execution` scope and `Slot.PROCEDURAL` (250) or `Slot.OBSERVATIONS` (200). They are assembled in the harness factory (`src/harness/factory.ts`) and activate when the CLI harness is created. For full documentation of each layer's slot, budget, state shape, and behavior, see `packages/cli/docs/enhanced-prompt-engineering.md`.

---

## Future Considerations

### durableTaskState: disk fallback, git integration, custom serialization (Not Yet Designed)

Potential extensions to `durableTaskState()`: a configurable on-disk fallback (`baseDir`, default `.noetic/tasks`) for crash recovery independent of the `StorageAdapter`, optional git commits of task state (`gitCommit`), a Zod `schema` for state validation, and a custom `serializer`. These would reintroduce a config parameter; the design (dual-persistence consistency, commit cadence, schema-migration interplay) has not been worked out. Not scheduled.

---

## Checklist for Custom Layer Authors

1. Pick a unique `id`. Namespace it: `'mycompany/layer-name'`.
2. Choose the narrowest `scope`. Don't use `'global'` if `'resource'` suffices.
3. Implement `init` if you have state. Use `void` for `TState` if stateless.
4. Use `ctx.tokenize()`. Don't bring your own tokenizer.
5. Respect the `budget` parameter in `recall()`. Trim your output to fit.
6. Handle errors in external calls. The timeout policy is a safety net.
7. Use JSON-serializable state. No `Map`, `Set`, `Date` objects.
8. Version your state if you plan to evolve the schema.
9. Clean up in `dispose()`. Close connections, cancel subscriptions.
10. Test with the layer disabled. Your agent should work (degraded) without any single layer.
