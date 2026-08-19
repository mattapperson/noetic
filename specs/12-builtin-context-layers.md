# Built-In Context Layers

> **Module:** `@noetic-tools/context` (source at `packages/context/src/context/layers/**`); re-exported by `@noetic-tools/core`.
> **Depends On:** `11-context-layer-system` (ContextLayer, ContextLayerHooks, Slot, ScopedStorage, BudgetConfig, all hook param types)
> **Exports:** `instructions()`, `history()`, `scratchpad()`, `observations()`, `temporal()`, `filesystem()`, `plan()`, `taskState()`, `toolCalls()`, `steering()`, `ScratchpadConfig`, `ObservationsConfig`, `TemporalConfig`, `TemporalFact`, `TemporalSearchResult`, `FactExtractor`, `FactSearcher`, `TaskState`, `TaskStateOptions`, `SteeringConfig`, `SteeringRule`, `PlanConfig`, `PlanState`, `PlanPhase`, `PlanExecutionEntry`

---

These are informative reference implementations. They are NOT special-cased in the runtime — they use the same `ContextLayer` interface as custom layers.

All layers return `Item[]` from `recall` — each block is a `MessageItem` with `role: developer` (framework-injected context, distinct from user-authored `system` instructions).

---

## `scratchpad()`

Always-available structured or freeform state, injected near the top of the View.

```typescript
interface ScratchpadConfig {
  scope?: 'thread' | 'resource';
  schema?: ZodType;
  template?: string;
  readOnly?: boolean;
}

function scratchpad(config?: ScratchpadConfig): ContextLayer<ScratchpadState>
```

| Property | Value |
|----------|-------|
| **id** | `'scratchpad'` |
| **slot** | `Slot.SCRATCHPAD` (100) |
| **scope** | `config.scope ?? 'thread'` |
| **budget** | `{ min: 200, max: 1500 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

**Behavior:**
- `init`: Loads state from `ScopedStorage`. Defaults to `{}` (schema) or `''` (freeform). Persisted state that fails the configured schema falls back to `{}` (corrupt state must not abort the execution).
- `recall`: Renders state as `<scratchpad>` block in a `MessageItem` with `role: developer`. Returns `null` if empty.
- `store`: Watches for `FunctionCallItem` with `name: 'scratchpad/update'`. Deep-merges structured state (object-valued keys merge recursively; arrays and primitives replace). When a schema is configured, the **merged** state is validated (partial updates stay legal); a violating merge throws — the runtime logs a diagnostic and drops the update, leaving prior state untouched.
- `onSpawn`: Clones state for `scope: 'resource'`. Returns `null` otherwise.

**Provides:**

The scratchpad exposes two declarations via its `provides` map, making state available to code steps and LLM tool calls:

| Name | Kind | Description |
|------|------|-------------|
| `snapshot` | `layerData` | Returns the current scratchpad state as-is. |
| `update` | `layerFunction` | Merges new key-value pairs into the state. Exposed as `scratchpad/update` LLM tool. |

```typescript
provides: {
  snapshot: layerData({ read: (state) => state }),
  update: layerFunction({
    description: 'Update the agent scratchpad with new key-value pairs.',
    input: z.record(z.string(), z.unknown()),
    output: z.void(),
    // Deep-merges args into state recursively (objects merge, arrays/primitives
    // replace). __proto__ / constructor are stripped at every depth.
    execute: async (args, state) => ({ result: undefined, state: deepMerge(state, args) }),
  }),
}
```

- **`snapshot`** — A data declaration. Code steps access it synchronously via `ctx.context['scratchpad'].snapshot`, which returns the full `ScratchpadState`.
- **`update`** — A function declaration. Code steps call it as `await ctx.context['scratchpad'].update({ key: 'val' })`. The runtime also exposes it as an LLM tool named `scratchpad/update`, allowing the model to update the scratchpad through the standard tool-call mechanism. When a `schema` is configured, the merged state is validated; a violating update throws, surfacing as a tool error the model can see, and the state is unchanged.
- **Deep merge:** Updates merge recursively — nested object keys are deep-merged rather than overwritten; arrays and primitives replace. When the prior state is a freeform **string** and an object update arrives, the prior string is preserved under a `_previous` key instead of being silently discarded.
- **Prototype poisoning protection:** The merge strips `__proto__` and `constructor` keys from incoming arguments at every depth.
- **Function-call path:** The `store` hook also detects `findFunctionCall(newItems, 'scratchpad/update')` for responses that carry the update as a raw function-call item rather than through the tool pipeline. Both paths apply the same prototype-stripping and merge logic.
- **Type-safe access:** The `scratchpad()` factory returns its result `satisfies ContextLayer<ScratchpadState>`, preserving the literal layer id and provides shape at the type level. Combine `context([scratchpad()])` with `InferContext<typeof mem>` to get compile-time typed access to `ctx.context['scratchpad']`.

---

## `observations()`

Distills conversation into concise observations using a background LLM call.

```typescript
interface ObservationsConfig {
  bufferThreshold?: number;    // tokens before observer runs, default 2000
  maxObservations?: number;    // max kept, default 50 (compaction beyond)
  observerModel?: string;      // default: haiku
  observerPrompt?: string;
  scope?: 'thread' | 'resource';
}

function observations(config?: ObservationsConfig): ContextLayer<ObservationsState>
```

| Property | Value |
|----------|-------|
| **id** | `'observations'` |
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

## `temporal()`

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

interface TemporalConfig {
  now?: () => Date;            // injectable clock (tests/replay); default () => new Date()
  scope?: 'thread' | 'resource';
  extract?: FactExtractor;     // store-side distillation; omitted → buffer only, never fabricate
  search?: FactSearcher;       // searchMemory backing; omitted → tool returns the raw ledger
  bufferThreshold?: number;    // tokens before extract runs, default 2000
  maxFacts?: number;           // ledger cap, default 200 (oldest timestamps dropped)
  groundDateTime?: boolean;    // inject <current_datetime> on recall, default true
  injectLedger?: boolean;      // also inject <remembered_facts> on recall, default false
}

function temporal(config?: TemporalConfig): ContextLayer<TemporalState>
```

| Property | Value |
|----------|-------|
| **id** | `'temporal'` |
| **slot** | `Slot.REMINDER` (80) |
| **placement** | `'live'` when `groundDateTime`, else `'auto'` — the `<current_datetime>` block changes every turn by construction, so anchoring it would re-bill the window each time. With grounding off only the slow-moving ledger remains, which is worth anchoring. |
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
| `searchMemory` | `layerFunction` | Given `{ query }`, returns `TemporalSearchResult`. Exposed as the `temporal/searchMemory` LLM tool. Delegates to the injected `search` callback; without one, returns the raw `[ts] fact` ledger so the tool degrades gracefully. |

**Design:** The layer is LLM-agnostic — `extract`/`search` are injected by the host (mirroring `observations()`'s `observer`), so `@noetic-tools/context` stays tree-shakable. The code agent wires structured `callModel` calls as the callbacks and installs `temporal()` in its default stack.

---

## `taskState()`

Persists task-level artifacts (files modified, progress checkpoints, arbitrary data) across spawn boundaries and across executions within a thread. This replaces a standalone `Persistence` interface — all state that survives across fresh-context iterations is managed uniformly through context layers.

```typescript
interface TaskState {
  checkpoints: Array<{ timestamp: number; depth: number }>;
  files: string[];
  data: Record<string, unknown>;
}

type TaskStateDataMerge = 'shallow' | 'namespace';

interface TaskStateOptions {
  /** How `data` merges at a child boundary. Default: `'shallow'`. */
  mergeData?: TaskStateDataMerge;
}

function taskState(opts?: TaskStateOptions): ContextLayer<TaskState>
```

| Property | Value |
|----------|-------|
| **id** | `'task-state'` |
| **slot** | `Slot.SCRATCHPAD + 10` (110) |
| **scope** | `'thread'` |
| **budget** | `{ min: 100, max: 800 }` |
| **timeouts** | `{ store: 30_000 }` |
| **provides** | `recordArtifact`, `setTaskData` |
| **hooks** | `init`, `recall`, `store`, `onSpawn`, `onReturn`, `onComplete` |

**Behavior:**
- `init`: Loads saved state from `ScopedStorage` (written by the runtime's durable write-through mirror; see spec 11 *Durable Persistence*). Defaults to an empty state.
- `recall`: Renders the state as a `<task_state>` block in a `MessageItem` with `role: developer`, trimmed to the allocated budget — the oldest checkpoints are halved away while the render exceeds the budget, with a final closing-tag-preserving char-slice guard. A zero budget is fail-open (full render).
- `store`: Appends a `{ timestamp, depth }` checkpoint per model call, capped at the newest **50** checkpoints.
- `onSpawn`: **Always** provides child state (unlike other layers that may return `null`).
- `onReturn`: Merges child files/checkpoints/data back into parent (checkpoints capped at 50 after the merge, newest kept). `files` is a set union; `data` follows the configured merge strategy.
- `onComplete`: Final checkpoint stamped with the completing execution's `ctx.depth`, plus the outcome label under `data.__outcome` (capped).

**Write API (`provides`):** the layer is writable by the model, exposed as the tools `task-state/recordArtifact` and `task-state/setTaskData`.

| Function | Input | Effect |
|----------|-------|--------|
| `recordArtifact` | `{ path: string }` | Appends `path` to `files`. Idempotent — recording the same path twice is a no-op. |
| `setTaskData` | `{ key: string; value: unknown }` | Sets `data[key]`. Refuses the reserved key `__outcome`, which `onComplete` owns. |

Without these, `files` and `data` would only ever be written by the framework, and a worker would have no way to report what it produced.

**`data` merge strategies:**

| Strategy | Merge | Use |
|----------|-------|-----|
| `'shallow'` (default) | `{ ...parent.data, ...childState.data }` | One child at a time. Concurrent children writing the same key clobber each other — last to return wins. |
| `'namespace'` | `parent.data[childCtx.executionId] = childState.data` | Coordinator/worker fan-out. Each worker's result is preserved under its own execution id. |

`onReturn` receives the child's `ExecutionContext` as `childCtx` (spec 11), which is what makes namespacing possible.

**Key design:** Scope is `'thread'` so the state persists across executions/iterations within the same thread (an `'execution'` scope would rotate its key every run and defeat durable rehydration). Always crosses spawn boundaries — and inParallel boundaries, which run the same lifecycle (spec 03). Recalls into the View so the LLM can see progress.

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

function steering(config: SteeringConfig): ContextLayer<SteeringState>
```

| Property | Value |
|----------|-------|
| **id** | `'steering'` |
| **slot** | `Slot.STEERING` (90) |
| **placement** | `'live'` (mandatory) — `recall` drains the pending queue as it renders, so its output can never be replayed from a pin. Rendering after history also puts guidance where the model weighs it most. |
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

## `history()`

Caps the trailing items projected to the LLM on every turn. Slot `275` (after recall-contributing layers), scope `'execution'`. Hooks: `init` (returns `null` state) and `projectHistory`.

```typescript
function history(config?: { maxItems?: number }): ContextLayer<null>
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
const layers = [
  scratchpad(),
  observations(),
  history({ maxItems: 40 }),
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
}): ContextLayer<void>
```

Slot `Slot.RAG` (350), scope `'global'`, budget `{ min: 0, max: 6000 }`. Recall-only — searches, optionally re-ranks, trims to budget.

### Entity Graph

```typescript
function entityMemory(config: { extractorModel?: string }): ContextLayer<EntityGraphState>
```

Slot `Slot.ENTITY` (150), scope `'resource'`. Extracts entities from new items in `store`, renders relevant entities in `recall`.

### Shared Swarm Memory

```typescript
function sharedSwarmMemory(config: { channel: PubSubChannel }): ContextLayer<SwarmState>
```

Slot `380`, scope `'execution'`. Subscribes to peer findings in `init`, drains in `recall`, publishes in `store`, cleans up in `dispose`. Uses `onSpawn`/`onReturn` for parent-child finding merge.

### Semantic Recall (informative recipe)

Vector-search over past items, injected for relevant context. Not a built-in export — a custom layer built from the same hooks:

```typescript
interface SemanticRecallConfig {
  vectorStore: VectorStore;
  embedder: Embedder;
  topK?: number;
  contextWindow?: number | { before: number; after: number };
  minScore?: number;
  scope?: 'thread' | 'resource' | 'global';
}

function semanticRecall(config: SemanticRecallConfig): ContextLayer<void>
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

**Recipe types:**

```typescript
interface VectorStore {
  search(embedding: number[], opts: { topK: number; filter: unknown; minScore: number }): Promise<VectorResult[]>;
  upsert(entry: { id: string; embedding: number[]; metadata: unknown }): Promise<void>;
}

interface Embedder {
  embed(text: string): Promise<number[]>;
}
```

### Episodic Memory (informative recipe)

Records execution summaries and retrieves relevant past experiences. Not a built-in export — a custom layer built from the same hooks:

```typescript
interface EpisodicMemoryConfig {
  store: EpisodicStore;
  embedder: Embedder;
  retrieval?: 'embedding' | 'recency' | 'both';
  maxEpisodes?: number;
  scope?: 'resource' | 'global';
}

function episodicMemory(config: EpisodicMemoryConfig): ContextLayer<void>
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

**Recipe types:**

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

## `plan()`

Manages the full plan lifecycle: entering plan mode, authoring a PRD, structuring the plan as a JSON workflow document, and tracking execution outcomes. A plan's tree IS a `WorkflowDocument` (spec 26); plans additionally store NAMED workflows referenced from the tree via `subflow` nodes, keeping the human-reviewed tree small while detailed mechanics live in separately-authored workflows.

```typescript
interface PlanConfig {
  scope?: ContextScope;
  additionalAllowedTools?: string[];
  maxPrdLength?: number;                      // default 50000
  maxDepth?: number;                          // workflowDepth cap for tree + each workflow; default 5
  maxWorkflows?: number;                      // named workflow count cap; default 20
  maxWorkflowChars?: number;                  // per-workflow JSON.stringify length cap; default 20000
  allowedNodeKinds?: WorkflowNode['kind'][];  // optional profile; hosts using it must include 'subflow'
  style?: PlanStyle;                          // 'phased' (default) | 'interview'
  subAgentTool?: string;                      // host's sub-agent tool name; gates the parallel-exploration guidance
  additionalPlanInstructions?: string;
  onEnterSession?: PlanEnterSessionCallback;  // () => Promise<{ slug: string }>
  onExit?: PlanExitCallback;                  // (state) => Promise<{ approved: boolean }>
}

function plan(config?: PlanConfig): ContextLayer<PlanState>
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
  planTree: WorkflowDocument | null;
  workflows: Record<string, WorkflowDocument>;
  executionLog: PlanExecutionEntry[];
  version: number;
  planSlug?: string | null;   // set by onEnterSession
}
```

Workflow names are slugs (`/^[a-z0-9][a-z0-9_-]{0,63}$/`). Documents arriving as JSON strings (a common LLM tool-call shape) are parsed before validation; validation runs inside the layer functions via `WorkflowDocumentSchema.safeParse` — the tool-parameter schema stays `unknown` so the recursive node union is not serialized into every planning turn.

**Behavior:**
- `init`: Loads persisted `PlanState` from `ScopedStorage`. Defaults to idle with null PRD/tree and no workflows. A persisted tree that fails `WorkflowDocumentSchema` (e.g. a legacy format) resets to `null`; a missing `workflows` map backfills to `{}`.
- `recall`: Phase-dependent context injection. Returns `null` in idle. In `planning`, renders the `<plan_mode>` briefing: the read-only mandate, the allowed tools, the workflow set by `style`, PRD structure, workflow-document authoring guidance (node kinds, the schema `$id`, keep-the-tree-small rules), the action list, and the turn-ending rule — followed by the draft PRD, the current tree JSON, and one summary line per named workflow (node count + kind histogram; bodies are read back via `plan/getWorkflow`). In `executing`, renders `<active_plan>` with PRD, tree, and workflow summaries. In terminal phases, renders `<plan_outcome>`.
- **Budget:** the rendered block is fitted to `budget * 4` characters. State gives way first — the largest of the PRD draft, tree JSON, or workflow summaries is **trimmed to the remaining headroom** rather than dropped whole, so the budget is not spent on blank space. Rules are never cut mid-sentence: when they will not fit, a compact briefing replaces them, and when even that overflows, `recall` returns `null`. The layer therefore never emits a fragment of a rule, and never exceeds its budget.

**Planning styles** (`style`, default `'phased'`):

| Style | Shape of the turn | Suits |
|-------|-------------------|-------|
| `'phased'` | Understand → design → review → write → exit | Work whose shape is already known |
| `'interview'` | Explore → write → ask, on repeat, building the PRD from a skeleton | Requests whose requirements are still vague |

Both styles end a turn the same way: with `AskUserQuestion`, or with `plan/exitPlanMode`. Asking for approval in prose is explicitly ruled out — that request IS `exitPlanMode`.

**Rendered from configuration, not hard-coded.** The briefing's tool list is the layer's own allow-set (so `additionalAllowedTools` appears in it), the node-kind guidance is filtered by `allowedNodeKinds`, and `setPlanTree`'s tool description is built from the same kind table as the briefing — the two cannot disagree about what a plan may contain. Sub-agent guidance appears only when `subAgentTool` names a tool the host actually registers; the layer ships none, and instructing the model to call a tool that does not exist costs a turn.
- `beforeToolCall`: In `planning` phase, restricts tools to read-only (`Read`, `Grep`, `Find`, `Ls`) plus plan layer tools and `activateSkill`. Denies mutating tools (`Write`, `Edit`, `Bash`). No restrictions outside planning phase.
- `onSpawn`: Deep-clones state to child execution.
- `onComplete`: If `executing`, records outcome in `executionLog` and transitions to `completed` or `failed`. State is returned to the runtime for persistence.

**Provides:**

| Name | Kind | Description |
|------|------|-------------|
| `status` | `layerData` | Read-only projection: `{ phase, hasPrd, hasPlanTree, workflowNames, version }`. |
| `enterPlanMode` | `layerFunction` | Transitions idle → planning. Accepts optional `goal` string to seed the PRD. Resets workflows from any prior plan. |
| `updatePrd` | `layerFunction` | Replaces the PRD content. Only works in planning phase. Validates max length. |
| `setPlanTree` | `layerFunction` | Sets the plan as `{ document: WorkflowDocument }`. Validates schema, depth, `allowedNodeKinds`, and subflow-ref slug syntax. Refs to not-yet-defined workflows are allowed — the success message enumerates them. |
| `setWorkflow` | `layerFunction` | Creates or replaces a named workflow (`{ name, document }`, upsert). Validates name slug, count cap (replacing at the cap is allowed), serialized size cap, depth, and `allowedNodeKinds`. |
| `removeWorkflow` | `layerFunction` | Deletes a named workflow. Warns when the tree or another workflow still references it. |
| `getWorkflow` | `layerFunction` | Returns a stored workflow's pretty-printed JSON. Read-only, works in any phase. |
| `exitPlanMode` | `layerFunction` | Exits plan mode. `action: 'execute'` validates PRD + tree exist, that every subflow ref (in the tree and inside stored workflows) names a stored workflow, and that named workflows form no reference cycle — all **before** invoking `onExit`, so the user is never asked to approve a plan that cannot hydrate. `action: 'cancel'` resets to idle. |

**Executing an approved plan:** `PlanState.planTree` is a `WorkflowDocument` and `PlanState.workflows` maps directly onto the JSON workflow runtime's registry, so a host executes the plan with `parseAndRunWorkflow`:

```typescript
const onExit: PlanExitCallback = async (state) => {
  const approved = await ui.requestApproval(state.prd, state.planTree, state.workflows);
  if (approved) {
    void parseAndRunWorkflow({
      json: state.planTree,
      workflows: new Map(Object.entries(state.workflows)),
      harness, ctx, tools, layers,
    });
  }
  return { approved };
};
```

The default CLI flow instead uses context injection — the plan is recalled into the LLM's view via `<active_plan>` and the model executes by making tool calls; `parseAndRunWorkflow` is the programmatic path.

---

## CLI-Specific Layers (`packages/cli`)

The CLI package (`packages/cli/src/memory/`) provides several context layers built on the `@noetic-tools/context` interface. These implement prompt engineering patterns adapted from Claude Code's system:

| Layer | Source | Purpose |
|-------|--------|---------|
| `promptEngineeringLayer()` | `packages/cli/src/memory/prompt-engineering-layer.ts` | Core behavioral guidelines, tool usage tracking, error-based adaptation |
| `communicationStyleLayer()` | `packages/cli/src/memory/communication-style-layer.ts` | Adaptive communication patterns (concise/normal/verbose) based on user message analysis |
| `environmentContextLayer(config)` | `packages/cli/src/memory/environment-context-layer.ts` | Dynamic environment detection (platform, git, Node.js, shell, package manager) |
| `toolGuidanceLayer(config)` | `packages/cli/src/memory/tool-guidance-layer.ts` | Context-aware tool preference hierarchy and mode-specific guidance |
| `planningModeLayer(config)` | `packages/cli/src/memory/planning-mode-layer.ts` | Plan-mode instructions with workflow-document authoring, PRD authoring, phase tracking |
| `skillsLayer(definitions, config)` | `@noetic-tools/code-agent` (`packages/code-agent/src/memory/skills-layer.ts`), re-exported via `packages/cli/src/memory/skills-layer.ts` | Progressive skill disclosure with inline command processing |

These layers all use `execution` scope and `Slot.PROCEDURAL` (250) or `Slot.OBSERVATIONS` (200). They are assembled in the harness factory (`src/harness/factory.ts`) and activate when the CLI harness is created. For full documentation of each layer's slot, budget, state shape, and behavior, see `packages/cli/docs/enhanced-prompt-engineering.md`.

---

## Future Considerations

### taskState: disk fallback, git integration, custom serialization (Not Yet Designed)

Potential extensions to `taskState()`: a configurable on-disk fallback (`baseDir`, default `.noetic/tasks`) for crash recovery independent of the `StorageAdapter`, optional git commits of task state (`gitCommit`), a Zod `schema` for state validation, and a custom `serializer`. These would reintroduce a config parameter; the design (dual-persistence consistency, commit cadence, schema-migration interplay) has not been worked out. Not scheduled.

---

## Declared Placements

Only layers whose volatility is known up front declare a `placement` (spec 11, Prompt-Cache Anchoring). The rest are left `'auto'`, because how often they change depends on the workload, and the runtime decides from what it observes.

| Layer | Placement | Why |
|---|---|---|
| `steering()` | `'live'` | `recall` drains its queue as it renders — a pin would lose the feedback |
| `temporal()` | `'live'` while grounding the clock, else `'auto'` | `<current_datetime>` changes every turn by construction |
| `instructions()` | `'anchor'` | Loaded once in `init`, never rewritten |
| `filesystem()` | `'anchor'` + `renderDelta` | Large payload, changes a file at a time — the case anchoring pays off most on |
| everything else | `'auto'` | Workload-dependent; let observed churn decide |

`history()` declares none: it contributes only `projectHistory` and never enters either band.

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
11. Leave `placement` unset unless you know the layer's volatility. Declare `'live'` if `recall()` changes state or re-renders every turn; declare `'anchor'` only if the content genuinely cannot change mid-session. Add `renderDelta` only when the payload is large and its changes are small.
