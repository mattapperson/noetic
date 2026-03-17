# Eval and Optimization

> **Depends On:** `01-step-type` (Step), `02-step-variants` (step.run, step.llm, Tool), `03-control-flow` (branch, fork), `04-spawn` (spawn), `05-loop-and-until` (loop, until), `07-context-and-event-log` (Context, Item), `08-runtime` (Runtime, execute), `10-observability` (Span), `13-patterns` (react, ralphWiggum)
> **Exports:** `describe()`, `it()`, `EvalSuiteOptions`, `DescribeStep`, `ScorerFn`, `createScorer()`, `createAdapter()`, `Baseline`, `OptimizationLevel`, `discoverFieldsFromSource()`

---

## Overview

`@noetic/eval` provides scored evaluation and optimization for step compositions. It answers two questions:

1. **"How good is this agent?"** — Run a step against labeled or unlabeled examples, score the outputs, report metrics.
2. **"Can this agent be better?"** — Discover tunable fields in the step tree, mutate them, evaluate, and write back improvements.

The package is separate from `@noetic/core` because evaluation is a development-time concern. It depends on `@noetic/core` as a peer dependency and adds no runtime overhead to production agents.

---

## Eval Model

### `describe()` + `it()` API

Evaluation suites use a `describe()`/`it()` API modeled after test runners. `describe()` groups related evaluations. `it()` defines a single evaluation case. This is intentional — evals are tests with scores instead of pass/fail.

```typescript
function describe(step: DescribeStep, options: EvalSuiteOptions, fn: () => void): void;

function it(name: string, fn: (ctx: EvalContext) => Promise<void>): void;
```

### `DescribeStep`

```typescript
/** Widened step type — accepts Step with any I/O types. */
type DescribeStep = {
  kind: Step['kind'];
  id: string;
};
```

### `EvalSuiteOptions`

```typescript
interface EvalSuiteOptions {
  /** The objective being evaluated. */
  objective: string;

  /** Optional background context for scorers. */
  background?: string;

  /** Optimization configuration. */
  optimize?: OptimizeConfig;

  /** Regression testing configuration. */
  regression?: RegressionConfig;
}
```

The eval context has **zero knowledge of `callModel`** — the `InMemoryRuntime` auto-detects from `OPENROUTER_API_KEY`. Memory layers, if needed, should be baked into the step tree (e.g., via `spawn({ child: step, memory })`), not passed through eval config.

### Execution Model

`describe()` wraps `Runtime.execute()`. Each `it()` case:

1. Creates a fresh `Context` via `runtime.createContext()`.
2. Calls `runtime.execute(step, input, ctx)` to produce the output.
3. Passes `{ input, output, expected, context, ctx }` to each scorer.
4. Collects scores into an `EvalResult`.

```typescript
interface EvalResult {
  name: string;
  scores: Record<string, ScoreValue>;
  duration: number;
  tokenUsage: TokenUsage;
  cost: number;
  error?: string;
}

interface ScoreValue {
  value: number;         // 0.0 to 1.0 normalized
  raw?: unknown;         // Scorer-specific raw output
  reason?: string;       // Explanation (from LLM-judge scorers)
}

interface EvalSuiteResult {
  name: string;
  cases: EvalResult[];
  aggregates: Record<string, { mean: number; median: number; min: number; max: number; stddev: number }>;
  totalDuration: number;
  totalCost: number;
}
```

**Invariant:** Every scorer returns a `value` in `[0.0, 1.0]`. Values outside this range cause the eval runner to throw `EvalError`.

**Invariant:** `describe()` blocks are isolated. Suite-level config does not leak between sibling `describe()` calls.

**Rationale:** The `describe()`/`it()` shape means existing test infrastructure (file watchers, CI runners, IDE integrations) works with evals. The eval runner discovers `.eval.ts` files the same way `bun test` discovers `.test.ts` files.

---

## Scorer System

### `ScorerFn` Contract

```typescript
interface ScorerInput {
  input: unknown;
  output: unknown;
  expected?: unknown;
  context?: Record<string, unknown>;
  ctx: Context;
}

type ScorerFn = {
  (input: ScorerInput): Promise<ScoreValue>;
  scorerName: string;
};
```

Every scorer is an async function with a `scorerName` property. The name is used as the key in `EvalResult.scores`.

**Invariant:** Scorers are pure observers. They must not mutate the `Context` or any input fields.

**Invariant:** Scorers must be idempotent. Calling a scorer twice with the same input produces the same score.

### Built-in Deterministic Scorers

Deterministic scorers require no LLM calls. They are fast, cheap, and reproducible.

| Scorer | Measures | Score |
|--------|----------|-------|
| `latency()` | Execution wall-clock time | `1.0 - clamp(duration / threshold, 0, 1)` |
| `cost()` | Total LLM cost from context metadata | `1.0 - clamp(totalCost / budget, 0, 1)` |
| `tokenEfficiency()` | Output tokens vs total tokens | `outputTokens / totalTokens` |
| `toolCallAccuracy()` | Tool calls matching expected sequence | Jaccard similarity of tool call names |
| `fileExists()` | Whether specified files exist on disk | `existingFiles / expectedFiles` |
| `custom(name, fn)` | User-defined deterministic logic | User-provided `[0.0, 1.0]` value |

```typescript
function latency(threshold: number): ScorerFn;
function cost(budget: number): ScorerFn;
function tokenEfficiency(): ScorerFn;
function toolCallAccuracy(expectedTools: string[]): ScorerFn;
function fileExists(paths: string[]): ScorerFn;
function custom(name: string, fn: (input: ScorerInput) => Promise<number>): ScorerFn;
```

### LLM-Judge Scorers

LLM-judge scorers use a model to evaluate output quality. They follow a consistent 4-step pipeline (see `createScorer` below).

| Scorer | Evaluates | Requires `expected` | Requires `context` |
|--------|-----------|---------------------|---------------------|
| `answerRelevancy()` | Output addresses the input question | No | No |
| `answerSimilarity()` | Output matches expected answer semantically | Yes | No |
| `faithfulness()` | Output is grounded in provided context | No | Yes (`documents`) |
| `hallucination()` | Output contains fabricated claims | No | Yes (`documents`) |
| `completeness()` | Output covers all aspects of the input | No | No |
| `promptAlignment()` | Output follows system prompt instructions | No | Yes (`systemPrompt`) |
| `toneConsistency()` | Output maintains specified tone | No | Yes (`tone`) |
| `toxicity()` | Output contains harmful content | No | No |
| `bias()` | Output exhibits demographic or ideological bias | No | No |
| `contextPrecision()` | Retrieved context is relevant to the query | No | Yes (`documents`) |
| `contextRelevance()` | Context items contribute to the answer | No | Yes (`documents`) |
| `fileReview()` | Generated file contents meet quality criteria | No | Yes (`criteria`) |
| `directoryReview()` | Generated directory structure meets criteria | No | Yes (`criteria`, `rootPath`) |

```typescript
function answerRelevancy(opts?: { model?: string }): ScorerFn;
function answerSimilarity(opts?: { model?: string; threshold?: number }): ScorerFn;
function faithfulness(opts?: { model?: string }): ScorerFn;
function hallucination(opts?: { model?: string }): ScorerFn;
function completeness(opts?: { model?: string }): ScorerFn;
function promptAlignment(opts?: { model?: string }): ScorerFn;
function toneConsistency(opts?: { model?: string }): ScorerFn;
function toxicity(opts?: { model?: string }): ScorerFn;
function bias(opts?: { model?: string }): ScorerFn;
function contextPrecision(opts?: { model?: string }): ScorerFn;
function contextRelevance(opts?: { model?: string }): ScorerFn;
function fileReview(opts?: { model?: string }): ScorerFn;
function directoryReview(opts?: { model?: string }): ScorerFn;
```

All LLM-judge scorers accept an optional `model` override. The default model is configurable at the suite level.

### `createScorer` — 4-Step Pipeline

Custom LLM-judge scorers are built with `createScorer`, which enforces a consistent 4-step pipeline:

```typescript
function createScorer(opts: {
  name: string;
  model?: string;
  extract: (input: ScorerInput) => Promise<Record<string, unknown>>;
  judge: (extracted: Record<string, unknown>) => string;
  parse: (response: string) => ScoreValue;
  validate?: (score: ScoreValue) => boolean;
}): ScorerFn;
```

**Pipeline steps:**

1. **Extract** — Pull relevant fields from the `ScorerInput`. This normalizes the input for the judge prompt. Runs as a pure function, no LLM call.
2. **Judge** — Build the judge prompt from extracted fields. Returns the prompt string. The pipeline calls the LLM with this prompt.
3. **Parse** — Parse the LLM response into a `ScoreValue`. Handles structured output extraction (JSON blocks, numeric values, reasoning).
4. **Validate** (optional) — Post-parse validation. Returns `false` to trigger a retry (up to 2 retries). Defaults to range check `[0.0, 1.0]`.

**Rationale:** The 4-step pipeline ensures every LLM-judge scorer is inspectable, testable in isolation (mock the LLM, test parse/extract independently), and consistent in error handling. Built-in LLM-judge scorers are all implemented via `createScorer`.

---

## `_optimizable` Annotation

### Problem

The optimizer needs to discover tunable fields inside step trees. Most steps are straightforward — walk the tree, find `model`, `system`, `tools` fields. But `branch` and `fork` steps contain dynamic functions (`route`, `paths`) that return steps at runtime, making their children invisible to static analysis.

### Solution

Builders for `branch` and `fork` annotate the step with an `_optimizable` property containing the statically-known children:

```typescript
interface OptimizableAnnotation {
  children: Step<unknown, unknown>[];
}

// On branch steps:
{
  kind: 'branch',
  id: 'router',
  route: (input, ctx) => { /* dynamic logic */ },
  _optimizable: {
    children: [analyzeStep, summarizeStep, defaultStep],
  },
}

// On fork steps:
{
  kind: 'fork',
  id: 'parallel-work',
  mode: 'all',
  paths: (input, ctx) => [stepA, stepB, stepC],
  _optimizable: {
    children: [stepA, stepB, stepC],
  },
}
```

The `branch()` builder populates `_optimizable.children` from the steps passed to `.when()` and `.otherwise()`. The `fork()` builder populates it from the steps array passed to `.paths()` when the argument is a static array (not a function).

**Invariant:** `_optimizable` is a development-time hint. The runtime interpreter ignores it entirely. Removing `_optimizable` has zero effect on execution.

**Invariant:** `_optimizable.children` may be a subset of the actual runtime children. The optimizer treats unlisted children as opaque.

**Rationale:** This avoids the need for runtime instrumentation or code evaluation to discover the step tree. The annotation is additive — it enables optimization without constraining execution.

---

## Optimization

Optimization is the process of automatically improving a step composition's eval scores. It operates in four phases: field discovery, mutation, evaluation, and source writeback.

### Optimization Levels

```typescript
const OptimizationLevel = {
  L1: 'prompts-only',
  L2: 'flow-structure',
  L3: 'full',
} as const;
type OptimizationLevel = (typeof OptimizationLevel)[keyof typeof OptimizationLevel];
```

| Level | Scope | What It Mutates | Risk |
|-------|-------|-----------------|------|
| L1 | Prompts only | `system`, `instructions`, tool descriptions | Low — behavioral change only |
| L2 | Flow structure | L1 + `model`, `maxSteps`, `maxIterations`, `tools` array membership | Medium — structural change |
| L3 | Full | L2 + step composition topology, custom code via pluggable coding agent | High — requires human review |

### Phase 1: Field Discovery (Step Tree Walker)

The optimizer walks the step tree to discover tunable fields.

```typescript
interface DiscoveredField {
  path: string[];                // JSONPath-style path to the field, e.g., ['react-loop', 'body', 'system']
  stepId: string;                // ID of the containing step
  fieldName: string;             // 'model' | 'system' | 'tools' | 'maxSteps' | etc.
  currentValue: unknown;         // Current value
  level: OptimizationLevel;      // Minimum optimization level required to mutate this field
}

function discoverFields(step: Step<unknown, unknown>): DiscoveredField[];
```

The walker recursively traverses:
- `loop.body` — descend into the loop body
- `spawn.child` — descend into the spawn child
- `fork._optimizable.children` — descend into annotated fork children
- `branch._optimizable.children` — descend into annotated branch children

Fields discovered per step kind:

| Step Kind | L1 Fields | L2 Fields | L3 Fields |
|-----------|-----------|-----------|-----------|
| `llm` | `system`, `params` | `model`, `tools` | (topology) |
| `loop` | (from body) | `maxIterations` | `until` predicates |
| `spawn` | (from child) | `timeout` | `memory` layers |
| `fork` | (from children) | `mode`, `concurrency` | path topology |

### Phase 2: Mutator (Immutable Clone + Replacement)

The mutator produces a new step tree with a single field changed. It never modifies the original.

```typescript
function mutateStep(
  root: Step<unknown, unknown>,
  field: DiscoveredField,
  newValue: unknown,
): Step<unknown, unknown>;
```

**Invariant:** `mutateStep` is a pure function. The input step tree is not modified. The output is a structurally shared clone where only the path to the mutated field is freshly allocated.

**Rationale:** Immutable mutation means the optimizer can evaluate multiple candidates concurrently without interference. It also means rollback is free — just discard the clone.

### Phase 3: GEPA Bridge (AxGEPA Integration)

The optimizer integrates with AxGEPA (Generalized Evolutionary Prompt Algorithm) for intelligent prompt optimization. The bridge translates between noetic's step tree representation and AxGEPA's optimization interface.

```typescript
interface GepaConfig {
  /** Population size per generation. */
  populationSize?: number;

  /** Maximum generations before stopping. */
  maxGenerations?: number;

  /** Target score threshold — stop early if achieved. */
  targetScore?: number;

  /** Fields to optimize. Filtered by optimization level. */
  fields: DiscoveredField[];

  /** The eval suite to use as the fitness function. */
  evalSuite: EvalSuiteConfig;

  /** Budget cap for the optimization run. */
  budget?: { maxCost?: number; maxTime?: number };
}

function createGepaBridge(config: GepaConfig): {
  optimize(): AsyncGenerator<GenerationResult>;
  best(): Step<unknown, unknown>;
};

interface GenerationResult {
  generation: number;
  population: Array<{
    step: Step<unknown, unknown>;
    scores: Record<string, number>;
    fitness: number;
  }>;
  bestFitness: number;
  elapsed: number;
  cost: number;
}
```

The bridge:
1. Encodes each `DiscoveredField` as a GEPA dimension.
2. Uses the eval suite as the fitness function — run all `it()` cases, aggregate scores.
3. Yields `GenerationResult` per generation for progress tracking.
4. Respects budget constraints (cost, time).

**Rationale:** GEPA is the mutation strategy, not the eval strategy. The eval package owns scoring; GEPA owns search. This separation means alternative search strategies (grid search, Bayesian optimization) can be swapped in without changing the eval or mutator layers.

### Phase 4: Source Writer (AST-Based Writeback)

After optimization, the source writer updates the original TypeScript source files with the optimized values.

```typescript
interface WritebackPlan {
  file: string;
  changes: Array<{
    field: DiscoveredField;
    oldValue: unknown;
    newValue: unknown;
    location: { line: number; column: number };
  }>;
}

function planWriteback(
  original: Step<unknown, unknown>,
  optimized: Step<unknown, unknown>,
  sourceFiles: string[],
): WritebackPlan[];

function executeWriteback(plans: WritebackPlan[]): void;
```

The source writer:
1. Parses source files into ASTs.
2. Locates the builder call sites corresponding to each changed field (matched by step `id` and field name).
3. Replaces the AST node value with the optimized value.
4. Prints the modified AST back to source, preserving formatting.

**Invariant:** `planWriteback` is pure — it computes changes without applying them. `executeWriteback` applies the changes. This two-phase design supports `--dry-run`.

**Invariant:** The source writer only modifies string literals, number literals, and array literals. It does not rewrite function bodies or control flow. L3 topology changes that require structural code modification are delegated to the pluggable coding agent.

### AST-Based Source Location Discovery

The optimizer needs to know WHERE in user source files each optimizable field lives so it can write changes back. Source locations are inferred automatically via TypeScript AST analysis — users never define them manually.

```typescript
function discoverFieldsFromSource(evalFilePath: string): OptimizableField[];
```

The static analysis module:
1. Takes an eval file path
2. Follows imports to find agent/step definition source files using TypeScript module resolution
3. Parses those files into TypeScript ASTs
4. Walks the AST to find builder calls (`step.llm()`, `tool()`, `react()`, `ralphWiggum()`, `branch()`, `fork()`, `spawn()`, `loop()`)
5. Extracts string literal values of optimizable fields (`system`, `description`, `name`) and their exact `SourceLocation` (file, line, column)
6. Returns `OptimizableField[]` with populated `sourceLocation`

The CLI optimizer calls `discoverFieldsFromSource()` for each loaded eval file, then enriches runtime-discovered fields with AST-discovered source locations via `enrichWithSourceLocations()`.

```typescript
function enrichWithSourceLocations(
  runtimeFields: OptimizableField[],
  astFields: OptimizableField[],
): OptimizableField[];
```

Matching is by `stepId` + `fieldKind` + `value`. This two-phase approach (runtime discovery for values, AST discovery for locations) means the optimizer works correctly even when step trees are dynamically constructed.

---

## Adapters

### `createAdapter` — Third-Party SDK Integration

Adapters bridge third-party LLM SDKs into the eval system, allowing evaluation of agents built outside `@noetic/core`.

```typescript
interface EvalAdapter {
  /** Wrap an external execution into the eval pipeline. */
  execute(input: unknown): Promise<{
    output: unknown;
    metadata: {
      duration: number;
      tokenUsage?: TokenUsage;
      cost?: number;
      toolCalls?: string[];
    };
  }>;
}

function createAdapter(opts: {
  name: string;
  provider: 'vercel-ai' | 'openai' | 'langchain' | 'custom';
  execute: (input: unknown) => Promise<{
    output: unknown;
    metadata: {
      duration: number;
      tokenUsage?: TokenUsage;
      cost?: number;
      toolCalls?: string[];
    };
  }>;
}): EvalAdapter;
```

When an `EvalSuiteConfig` includes an `adapter`, the eval runner calls `adapter.execute(input)` instead of `runtime.execute(step, input, ctx)`. Scorers receive the same `ScorerInput` shape regardless of whether the execution came from a native step or an adapter.

```typescript
// Example: evaluating a Vercel AI SDK agent
const vercelAdapter = createAdapter({
  name: 'vercel-ai-agent',
  provider: 'vercel-ai',
  execute: async (input) => {
    const start = performance.now();
    const result = await generateText({
      model: openai('gpt-4o'),
      prompt: input as string,
      tools: myTools,
    });
    return {
      output: result.text,
      metadata: {
        duration: performance.now() - start,
        tokenUsage: {
          input: result.usage.promptTokens,
          output: result.usage.completionTokens,
        },
        cost: result.usage.totalTokens * 0.00001,
        toolCalls: result.toolCalls.map((tc) => tc.toolName),
      },
    };
  },
});

describe('vercel-agent-eval', { adapter: vercelAdapter, scorers: [answerRelevancy()] }, () => {
  it('handles greetings', { input: 'Hello!', expected: 'A friendly greeting' });
});
```

**Invariant:** Adapters must return `metadata.duration` — it is the only required metadata field. All other metadata fields are optional and scorers that depend on them gracefully degrade (return `{ value: 0, reason: 'missing metadata' }`).

**Rationale:** The adapter layer means `@noetic/eval` is useful beyond the noetic ecosystem. Teams can adopt scored evaluation for any LLM application, then optionally migrate to `@noetic/core` for the optimization features.

---

## Regression

### Baseline Save/Load

A baseline is a snapshot of eval results that serves as the reference point for regression detection.

```typescript
interface Baseline {
  version: 1;
  createdAt: string;
  suites: Record<string, {
    cases: Record<string, {
      scores: Record<string, number>;
    }>;
    aggregates: Record<string, { mean: number; stddev: number }>;
  }>;
}

function saveBaseline(results: EvalSuiteResult[], path: string): void;
function loadBaseline(path: string): Baseline;
```

Baselines are stored as JSON files (default: `.noetic/baselines/<suite-name>.json`).

### Comparator

```typescript
interface RegressionResult {
  suite: string;
  case: string;
  scorer: string;
  baseline: number;
  current: number;
  delta: number;
  regressed: boolean;
}

function compareBaseline(
  baseline: Baseline,
  current: EvalSuiteResult[],
  opts?: { tolerance?: number },
): RegressionResult[];
```

**Default tolerance:** `0.05` (5%). A score drop exceeding the tolerance on any scorer/case pair is flagged as a regression.

### `--check` Flag

When `noetic test --check` is used:

1. Load the baseline for each suite.
2. Run all eval cases.
3. Compare results against the baseline.
4. Exit with code `1` if any regression is detected.
5. Print a diff table showing all changes.

This is designed for CI — add `noetic test --check` to the pipeline to catch regressions before merge.

**Rationale:** Baselines decouple "what is good enough" from "what is the current score." A team can lock baselines at a known-good state and flag any degradation, even if the absolute scores are not perfect.

---

## CLI

### `noetic test` Command

The CLI entry point for evaluation. Discovers `.eval.ts` files and runs them.

```
noetic test [files...] [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--verbose` | `boolean` | `false` | Print per-case score breakdowns and scorer reasons |
| `--json` | `boolean` | `false` | Output results as JSON (for CI integration) |
| `--watch` | `boolean` | `false` | Re-run evals when source or eval files change |
| `-u` | `boolean` | `false` | Update baselines with current results |
| `--scope` | `string` | `'*'` | Glob pattern to filter suites by name |
| `--budget` | `number` | (none) | Maximum cost in dollars for the entire eval run |
| `--dry-run` | `boolean` | `false` | Discover and report what would run without executing |
| `--save-baseline` | `string` | (none) | Save results as a baseline to the given path |
| `--check` | `boolean` | `false` | Compare against saved baseline, exit `1` on regression |

### Output Format

Default output (non-verbose):

```
Suite: my-agent-eval
  PASS  handles greetings          relevancy=0.92  faithfulness=0.88  latency=0.95
  PASS  handles complex queries    relevancy=0.85  faithfulness=0.91  latency=0.72
  FAIL  handles edge cases         relevancy=0.31  faithfulness=0.45  latency=0.98

Aggregates:
  relevancy:     mean=0.69  median=0.85  min=0.31  max=0.92
  faithfulness:  mean=0.75  median=0.88  min=0.45  max=0.91
  latency:       mean=0.88  median=0.95  min=0.72  max=0.98

3 cases | 2 passed | 1 failed | $0.12 | 4.2s
```

A case "fails" when any scorer returns a value below `0.5` (configurable via `EvalSuiteConfig.passThreshold`).

### Optimization via CLI

```
noetic test --optimize [--level L1|L2|L3] [--budget 5.00] [files...]
```

Runs the optimization pipeline after evaluation. The `--level` flag controls the optimization level. Results are printed as a diff showing before/after scores. With `--dry-run`, the writeback plan is printed without applying changes.

---

## Cross-References

- `Step<I, O>` discriminated union is defined in `01-step-type`
- `step.run`, `step.llm`, `Tool` are defined in `02-step-variants`
- `branch`, `fork` are defined in `03-control-flow`
- `spawn` is defined in `04-spawn`
- `loop`, `until` are defined in `05-loop-and-until`
- `Context`, `Item`, `TokenUsage` are defined in `07-context-and-event-log`
- `Runtime`, `execute` are defined in `08-runtime`
- `Span` is defined in `10-observability`
- `MemoryLayer` is defined in `11-memory-layer-system`
- `react`, `ralphWiggum` patterns are defined in `13-patterns`
