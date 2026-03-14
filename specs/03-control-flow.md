# Control Flow: `branch` and `fork`

> **Depends On:** `01-step-type` (Step<I,O>), `09-error-model` (OrchidError)
> **Exports:** `branch()`, `fork()`, `BranchOpts`, `ForkOpts`, `SettleResult`, `MergeFn`

---

## `branch()` — Conditional Routing

Inspects a value and selects which step to execute next. Returns the actual `Step`, not a string node name.

```typescript
interface BranchOpts<I, O> {
  id: string;
  route: (input: I, ctx: Context) => Step<I, O> | null;
}
```

```typescript
const routeByLanguage = branch<CodeFile, AnalysisResult>({
  id: 'route-by-language',
  route: (file, ctx) => {
    switch (file.language) {
      case 'typescript': return typescriptAnalyzer;
      case 'python':     return pythonAnalyzer;
      case 'rust':       return rustAnalyzer;
      default:           return genericAnalyzer;
    }
  },
});
```

LangGraph's conditional edges return string node names (`return "node_a"`), which TypeScript can't verify. Here, the router returns actual `Step` objects — TypeScript enforces that all branches return compatible output types.

Returning `null` is a no-op (skip this branch). This is useful in loops where some iterations don't need a particular branch.

---

## `fork()` — Parallel Execution

Splits execution into parallel paths and merges results.

### Modes

| Mode     | Behavior                               | Use Case                          |
|----------|----------------------------------------|-----------------------------------|
| `all`    | Wait for all paths, fail if any fails  | Task tree parallel children       |
| `race`   | Return first to complete, abort others | Competitive search, fastest model |
| `settle` | Wait for all, collect results + errors | Fault-tolerant batch processing   |

### Type-Safe Fork Options

The `merge` function is mandatory for `all` and `settle` modes — this eliminates `ForkResult` from the public API and ensures `fork` always produces `O`:

```typescript
type ForkOpts<I, O> =
  | { id: string; mode: 'race';   paths: (input: I, ctx: Context) => Step<I, O>[]; concurrency?: number }
  | { id: string; mode: 'all';    paths: (input: I, ctx: Context) => Step<I, O>[]; merge: (results: O[], ctx: Context) => O; concurrency?: number }
  | { id: string; mode: 'settle'; paths: (input: I, ctx: Context) => Step<I, O>[]; merge: (results: SettleResult<O>[], ctx: Context) => O; concurrency?: number }

type MergeFn<O> = (results: O[], ctx: Context) => O;
```

```typescript
interface SettleResult<O> {
  stepId: string;
  status: 'fulfilled' | 'rejected';
  value?: O;
  error?: OrchidError;
}
```

### Dynamic Fan-Out

The `paths` parameter is a function, not a static array. This enables LangGraph-style `Send` without a separate API:

```typescript
const dynamicSearch = fork({
  id: 'parallel-search',
  mode: 'all',
  paths: (query, ctx) => {
    const engines = ['google', 'bing', 'arxiv', 'github'];
    return engines.map(engine =>
      step.run({
        id: `search-${engine}`,
        execute: async () => searchEngine(engine, query),
      })
    );
  },
  merge: (results, ctx) => deduplicateAndRank(results),
  concurrency: 3,
});
```

### State Isolation

Each forked path receives a **deep clone** of the parent's `Context.state`. Mutations in one path do NOT affect other paths or the parent. After the fork completes:

- **`mode: 'all'`** / **`mode: 'settle'`** — The `merge` function receives the merged results. The parent's `Context.state` is NOT automatically updated from child mutations. If child state changes need to propagate, the `merge` function must return them as part of `O`.
- **`mode: 'race'`** — The winning path's `Context.state` replaces the parent's state.

This mirrors `spawn`'s deep-clone guarantee (see `04-spawn`) and prevents race conditions between concurrent paths.

### Error Behavior

- **`mode: 'all'`** — If any path fails, cancel remaining paths and throw `fork_partial` (see `09-error-model`) with both succeeded and failed results.
- **`mode: 'settle'`** — Never throws. Failed paths appear as `{ status: 'rejected' }` in the merge function's `SettleResult[]`. If ALL paths reject, the merge function still runs with an array of all-rejected `SettleResult` entries — it is the merge function's responsibility to handle this case (e.g., by throwing).
- **`mode: 'race'`** — First success wins. If all fail, throw `fork_partial`.
