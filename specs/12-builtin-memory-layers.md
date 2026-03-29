# Built-In Memory Layers

> **Package:** `@noetic/memory`
> **Depends On:** `11-memory-layer-system` (MemoryLayer, MemoryHooks, Slot, ScopedStorage, BudgetConfig, all hook param types)
> **Exports:** `workingMemory()`, `semanticRecall()`, `observationalMemory()`, `episodicMemory()`, `durableTaskState()`, `steering()`, `WorkingMemoryConfig`, `SemanticRecallConfig`, `ObservationalMemoryConfig`, `EpisodicMemoryConfig`, `DurableTaskStateConfig`, `SteeringConfig`, `SteeringRule`, `VectorStore`, `Embedder`, `EpisodicStore`, `DocumentRetriever`, `Reranker`, `PubSubChannel`

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
- `init`: Loads state from `ScopedStorage`. Defaults to `{}` (schema) or `''` (freeform).
- `recall`: Renders state as `<working_memory>` block in a `MessageItem` with `role: developer`. Returns `null` if empty.
- `store`: Watches for `FunctionCallItem` with `name: 'updateWorkingMemory'`. Validates against schema if provided. Deep-merges structured state.
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
    execute: async (args, state) => {
      // Prototype poisoning protection: __proto__ and constructor are stripped
      const merged = { ...state, ...safeArgs };
      return { result: undefined, state: merged };
    },
  }),
}
```

- **`snapshot`** — A data declaration. Code steps access it synchronously via `ctx.layer(wm).snapshot`, which returns the full `WorkingMemoryState`.
- **`update`** — A function declaration. Code steps call it as `await ctx.layer(wm).update({ key: 'val' })`. The runtime also exposes it as an LLM tool named `working-memory/update`, allowing the model to update working memory through the standard tool-call mechanism.
- **Prototype poisoning protection:** The `update` function strips `__proto__` and `constructor` keys from incoming arguments before merging.
- **Backward compatibility:** The `store` hook still detects `findFunctionCall(newItems, 'updateWorkingMemory')` for LLMs that emit the legacy function-call convention. Both paths apply the same prototype-stripping and merge logic.

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
| **timeouts** | `{ store: 60_000 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

**Behavior:**
- `init`: Loads versioned state from storage.
- `recall`: Renders observations as `<observations>` bullet list in a `MessageItem` with `role: developer`.
- `store`: Accumulates tokens. When threshold reached, runs observer LLM on unprocessed items. Compacts if over `maxObservations`.
- `onSpawn`: Clones observations to child.

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

Persists task-level artifacts (files modified, progress checkpoints, git commits) across spawn boundaries. This replaces a standalone `Persistence` interface — all state that survives across fresh-context iterations is managed uniformly through memory layers.

```typescript
interface DurableTaskStateConfig {
  baseDir?: string;          // default '.noetic/tasks'
  gitCommit?: boolean;       // default false
  schema?: ZodType;
  serializer?: {
    serialize: (state: unknown) => Promise<Buffer | string>;
    deserialize: (data: Buffer | string) => Promise<unknown>;
  };
}

function durableTaskState(config?: DurableTaskStateConfig): MemoryLayer<DurableTaskState>
```

| Property | Value |
|----------|-------|
| **id** | `'durable-task-state'` |
| **slot** | `Slot.WORKING_MEMORY + 10` (110) |
| **scope** | `'execution'` |
| **budget** | `{ min: 100, max: 800 }` |
| **timeouts** | `{ store: 30_000 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn`, `onReturn`, `onComplete` |

**Behavior:**
- `init`: Loads from storage, falls back to disk (crash recovery).
- `recall`: Renders current state, files modified, recent checkpoints as `<task_state>` block in a `MessageItem` with `role: developer`.
- `store`: Extracts state updates from response. Writes to disk + storage. Optional git commit.
- `onSpawn`: **Always** provides child state (unlike other layers that may return `null`).
- `onReturn`: Merges child files/checkpoints/data back into parent.
- `onComplete`: Final checkpoint with outcome label. Git commit if enabled.

**Key design:** Always crosses spawn boundaries. Dual persistence (disk + storage). Git integration is optional. Recalls into the View so the LLM can see progress.

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
  /** Max retries for LLM-evaluated rule calls before treating as pass. Default: 2. */
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
- **LLM evaluation**: When a rule has no `check` function, the layer sends a structured prompt: the rule description, the tool name and serialized args (for `beforeToolCall`) or the model output (for `afterModelCall`). The model responds with `{ violation: true | false, reason?: string }`. Retried up to `maxRetries` on parse failure; treated as pass on exhaustion. If no LLM provider is configured (no `callModel` on the execution context), LLM-evaluated rules throw a `NoeticConfigError` with code `MISSING_CALL_MODEL` — this is a fail-closed design to prevent silent bypass of security rules.
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
