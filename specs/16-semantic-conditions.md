# Semantic Conditions and Embedding-Based Routing

> **Depends On:** `03-control-flow` (branch, StepBranch), `05-loop-and-until` (ConvergeConfig)
> **Exports:** `Condition`, `WhenClause`, `OtherwiseClause`, `when()`, `otherwise()`, `semanticRoute()`, `semanticSwitch()`, `embeddingMatch()`, `aiCondition()`, `anyCondition()`, `allCondition()`, `cosineSimilarity()`, `EmbedFn`

---

## `EmbedFn` — Batch Embedding Interface

```typescript
type EmbedFn = (texts: readonly string[]) => Promise<readonly number[][]>;
```

Batch interface matches how embedding APIs work. Enables `semanticSwitch` to embed all labels in one call.

---

## `Condition<I>` — Async Boolean Predicate

```typescript
type Condition<I> = (input: I, ctx: Context) => Promise<boolean>;
```

All condition helpers return `Condition<I>`. They can be composed with `anyCondition` and `allCondition`, or used directly with `when()` in a `semanticRoute`.

---

## Clause Builders

### `when(condition, step)`

Pairs a `Condition<I>` with a `Step<I, O>`. Returns a `WhenClause<I, O>`.

### `otherwise(step)`

Fallback marker. Returns an `OtherwiseClause<I, O>`.

---

## Route Builders

### `semanticRoute(...clauses)`

Evaluates `WhenClause` conditions in order, returns the step from the first match. Falls through to `OtherwiseClause` if present. Returns `null` if no match and no otherwise.

Returns `(input: I, ctx: Context) => Promise<Step<I, O> | null>` — compatible with `StepBranch.route`.

### `semanticSwitch(opts)`

Embedding-based routing. Embeds the input and all case labels, picks the single best cosine-similarity match above threshold.

```typescript
// Simple form — string keys, one label per case
semanticSwitch({
  embed: EmbedFn,
  cases: Record<string, Step<I, O>>,
  default?: Step<I, O>,
  threshold?: number,     // default 0.7
  cache?: StorageAdapter,
})

// Advanced form — multi-label cases
semanticSwitch({
  embed: EmbedFn,
  cases: { labels: string | string[]; step: Step<I, O> }[],
  default?: Step<I, O>,
  threshold?: number,
  cache?: StorageAdapter,
})
```

Returns `(input: I, ctx: Context) => Promise<Step<I, O> | null>`.

---

## Condition Helpers

### `embeddingMatch(embed, label, threshold)` — Simple Form

Returns `Condition<I>` that checks if input is semantically similar to a label.

### `embeddingMatch(opts)` — Advanced Form

```typescript
embeddingMatch({
  embed: EmbedFn,
  labels: string[],
  threshold: number,
  match?: 'any' | 'all',  // default 'any'
  cache?: StorageAdapter,
})
```

### `aiCondition({ callModel, model, prompt })`

Returns `Condition<I>` that asks an LLM a yes/no question, parses boolean response via Zod.

### `anyCondition(...conditions)`

Returns `Condition<I>` true if any sub-condition is true. Short-circuits.

### `allCondition(...conditions)`

Returns `Condition<I>` true if all sub-conditions are true. Short-circuits on false.

---

## Input Serialization

All embedding conditions serialize input as: `typeof input === 'string' ? input : JSON.stringify(input)`.

---

## Caching Strategy

Label embeddings can be cached via optional `cache: StorageAdapter`. When provided:
- Labels are stored with a deterministic key: `embed:<encodeURIComponent(label)>`
- On each call, read from cache first; only call `embed()` on cache miss
- `semanticSwitch` batches: checks cache for all labels, embeds only misses in one batch, writes results back

When `cache` is omitted, fall back to in-memory closure state. Input embeddings are never cached (they change per call).

---

## `cosineSimilarity(a, b)`

Cosine similarity between two vectors. Returns `[-1, 1]`. Throws on dimension mismatch. Returns `0` for zero-magnitude vectors.
