# Eval and Optimization

> **Depends On:** `01-step-type` (Step), `02-step-variants` (step.run, step.llm, Tool), `03-control-flow` (branch, fork), `04-spawn` (spawn), `05-loop-and-until` (loop, until), `07-context-and-event-log` (Context, Item), `08-agent-harness` (AgentHarness, run), `10-observability` (Span), `13-patterns` (react, ralphWiggum)
> **Exports:** `describe()`, `it()`, `EvalSuiteOptions`, `DescribeStep`, `ScorerFn`, `createScorer()`, `createAdapter()`, `Baseline`, `OptimizationLevel`, `discoverFieldsFromSource()`

---

## Overview

`@noetic/eval` provides scored evaluation and optimization for step compositions. It answers two questions:

1. **"How good is this agent?"** — Run a step against labeled or unlabeled examples, score the outputs, report metrics.
2. **"Can this agent be better?"** — Discover tunable fields in the step tree, mutate them, evaluate, and write back improvements.

The package is separate from `@noetic-tools/core` because evaluation is a development-time concern. It depends on `@noetic-tools/core` as a peer dependency and adds no runtime overhead to production agents.

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

  /** Minimum score for a case to pass. Default: 0.5. */
  passThreshold?: number;

  /** Optimization configuration. */
  optimize?: OptimizeConfig;

  /** Regression testing configuration. */
  regression?: RegressionConfig;
}
```

The eval context has **zero knowledge of LLM provider configuration** — the `AgentHarness` auto-resolves from `OPENROUTER_API_KEY` or its `llm` config. Memory layers, if needed, should be baked into the step tree (e.g., via `spawn({ child: step, memory })`), not passed through eval config.

### Execution Model

`describe()` wraps `AgentHarness.run()`. Each `it()` case:

1. Creates a fresh `Context` via `harness.createContext()`.
2. Calls `harness.run(step, input, ctx)` to produce the output.
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
  suiteName: string;
  objective: string;
  cases: CaseResult[];
  aggregateScore: number;
  duration: number;
  timestamp: string;
}
```

The reporter computes per-scorer aggregates (mean, median, min, max, stddev) in verbose mode using utility functions from `utils/scores.ts`:

```typescript
function averageScores(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number;
function medianScore(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number;
function minScore(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number;
function maxScore(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number;
function stddevScore(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number;
```

**Invariant:** Every score that reaches case results, suite aggregates, and baselines is finite and in `[0.0, 1.0]`. The runner sanitizes any out-of-range or non-finite (`NaN`/`Infinity`) scorer result — clamping finite values, mapping non-finite values to `0`, and recording the original value in `metadata.sanitizedFrom`.

**Invariant:** `describe()` blocks are isolated. Suite-level config does not leak between sibling `describe()` calls.

**Rationale:** The `describe()`/`it()` shape means existing test infrastructure (file watchers, CI runners, IDE integrations) works with evals. The eval runner discovers `.eval.ts` files the same way `bun test` discovers `.test.ts` files.

---

## Scorer System

### `ScorerFn` Contract

```typescript
interface EvalExecution {
  output: unknown;
  context: Context;
  traces: Span[];
  score(scorers: ScorerFn[]): Promise<ScoreResult[]>;
}

type ScorerFn = (
  execution: EvalExecution,
  objective: string,
  background: string,
) => Promise<ScoreResult>;

interface ScoreResult {
  scorerId: string;
  score: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}
```

Scorers receive the full `EvalExecution` (output, context with token/cost metadata, traces) along with the suite's objective and background strings. The `scorerId` in the result is used as the key in score aggregations.

**Invariant:** Scorers are pure observers. They must not mutate the `Context` or any input fields.

**Invariant:** Scorers must be idempotent. Calling a scorer twice with the same input produces the same score.

**Invariant:** Score values must be in `[0.0, 1.0]`. The scorer pipeline clamps out-of-range values and adds `metadata.clamped: true` to the result.

### Built-in Deterministic Scorers

Deterministic scorers require no LLM calls. They are fast, cheap, and reproducible.

| Scorer | Measures | Score |
|--------|----------|-------|
| `latency()` | Execution wall-clock time | `1.0` at/below `target`, falling linearly to `0` at `maxAcceptable`, clamped to `[0, 1]` |
| `cost()` | Total LLM cost from context metadata | `1.0 - clamp(totalCost / budget, 0, 1)` |
| `tokenEfficiency()` | Output tokens vs total tokens | `outputTokens / totalTokens` |
| `toolCallAccuracy()` | Tool calls matching expected sequence | Jaccard similarity of tool call names |
| `fileExists()` | Whether specified files exist on disk | `existingFiles / expectedFiles` |
| `custom(name, fn)` | User-defined deterministic logic | User-provided `[0.0, 1.0]` value |

```typescript
// Throws RangeError at construction when maxAcceptable < target.
// target === maxAcceptable degenerates to a step function around target.
function latency(opts: { target: number; maxAcceptable: number }): ScorerFn;
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
function toxicity(opts?: { model?: string; threshold?: number; categories?: string[] }): ScorerFn;
function bias(opts?: { model?: string }): ScorerFn;
function contextPrecision(opts?: { model?: string }): ScorerFn;
function contextRelevance(opts?: { model?: string }): ScorerFn;
function fileReview(opts?: { model?: string }): ScorerFn;
function directoryReview(opts?: { model?: string }): ScorerFn;
```

All LLM-judge scorers accept an optional `model` override. The default model is configurable at the suite level.

**Threshold gating:** `answerSimilarity` and `toxicity` accept an optional `threshold`. When set, the score becomes a binary gate — a raw judge score at or above the threshold maps to `1`, below maps to `0` — and the raw judge score is preserved in `metadata.rawScore`. Note `toxicity`'s inversion: the judge scores NON-toxicity (`1.0` = clean), so `toxicity({ threshold: 0.8 })` passes only outputs rated at least 0.8 clean.

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
| L1 | Prompts only | `instructions`, tool descriptions | Low — behavioral change only |
| L2 | Flow structure | L1 + `model`, `maxSteps`, `maxIterations`, `tools` array membership | Medium — structural change |
| L3 | Full | L2 + step composition topology, custom code via pluggable coding agent | High — requires human review |

### Phase 1: Field Discovery (Step Tree Walker)

The optimizer walks the step tree to discover tunable fields.

```typescript
interface DiscoveredField {
  path: string[];                // JSONPath-style path to the field, e.g., ['react-loop', 'body', 'instructions']
  stepId: string;                // ID of the containing step
  fieldName: string;             // 'model' | 'instructions' | 'tools' | 'maxSteps' | etc.
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
| `llm` | `instructions`, `params` | `model`, `tools` | (topology) |
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

The optimizer integrates with `@ax-llm/ax`'s `AxGEPA` (Generalized Evolutionary Prompt Algorithm) for intelligent prompt optimization. The bridge implements a custom `AxGEPAAdapter` that translates between noetic's step tree representation and AxGEPA's optimization interface.

```typescript
interface GepaConfig {
  /** Model for candidate generation (default: openai/gpt-4o-mini). */
  studentModel?: string;

  /** Model for reflection/teaching (default: openai/gpt-4o). */
  teacherModel?: string;

  /** Number of optimization trials (default: 5). */
  numTrials?: number;

  /** Stop after N trials with no improvement (default: 3). */
  earlyStoppingTrials?: number;

  /** Enable verbose logging. */
  verbose?: boolean;
}

interface OptimizeParams {
  step: Step;
  fields: OptimizableField[];
  runEval: (step: Step) => Promise<Record<string, number>>;
  examples?: ReadonlyArray<Record<string, unknown>>;
  maxMetricCalls?: number;
  budget?: number;
  gepa?: GepaConfig;
}

function optimizeWithGepa(params: OptimizeParams): Promise<OptimizationResult>;
```

AxGEPA keys candidates by the ax program's optimizable-component ids, not by noetic field paths. The bridge therefore carries ALL noetic field values inside a single instruction component as marker-delimited blocks:

```
=== NOETIC FIELD <path> ===
<value>
=== END NOETIC FIELD ===
```

`serializeFields()`/`parseFieldText()` round-trip this format; the parser re-serializes and compares against its input, so any corrupted text (including values embedding an exact marker line) fails closed to the original values.

The bridge:
1. Builds a fixed carrier program (`currentText:string -> improvedText:string`) whose instruction holds the serialized fields, and discovers the carrier's component id via `program.getOptimizableComponents()` (the `kind === 'instruction'` entry) — never hardcoded.
2. Creates an `AxGEPAAdapter` whose `evaluate()` parses the candidate's serialized text and runs the eval suite against the MUTATED step (via `applyCandidate()`); destroyed markers evaluate the original step.
3. Implements `propose_new_texts` — taking precedence over GEPA's free-form reflection, which would destroy the markers. The teacher model improves each field value individually and the bridge reassembles the marker structure; a failed proposal falls back to the current value.
4. Builds a reflective dataset from evaluation scores to guide the teacher model's improvements.
5. Initializes `AxGEPA` with student/teacher AI services resolved from `OPENROUTER_API_KEY` and calls `AxGEPA.compile()` with the adapter, forwarding `maxMetricCalls` for budget control.
6. Extracts the best candidate as the **argmax of average score** over the Pareto front, decoding `configuration.componentMap[componentId]` (falling back to `configuration.instruction`); unparseable points fall back to the initial values.

**Fallback:** If `OPENROUTER_API_KEY` is not set, the bridge evaluates the initial candidate once and returns it unchanged (no optimization). This allows eval suites to run without optimization infrastructure.

**Rationale:** GEPA is the mutation strategy, not the eval strategy. The eval package owns scoring; GEPA owns search. This separation means alternative search strategies (grid search, Bayesian optimization) can be swapped in without changing the eval or mutator layers.

### Phase 4: Source Writer (Location-Based Writeback)

After optimization, the source writer updates the original TypeScript source files with the optimized values at the discovered string-literal locations.

```typescript
interface WriteBackEntry {
  /** Position of the opening quote of the target string literal (1-based). */
  sourceLocation: SourceLocation;
  /** Current value; a mismatch at the location throws instead of writing. */
  expectedValue?: string;
  newValue: string;
}

interface WriteBackReport {
  /** Literals actually replaced. */
  written: number;
  /** Entries skipped (stale line, column not on a quote), each with a reason. */
  skipped: Array<{ sourceLocation: SourceLocation; reason: string }>;
}

function writeOptimizedValues(entries: WriteBackEntry[]): Promise<WriteBackReport>;
```

The source writer:
1. Groups entries by file and applies them bottom-up, right-to-left — sorted by `(line desc, column desc)` — so earlier replacements never shift the coordinates of later ones (including two entries on one line).
2. Replaces the string literal whose opening quote sits at the entry's 1-based `line`/`column`. A location that does not land on a quote character is **reported as skipped with a reason**, never silently dropped; a file whose entries were all skipped is left untouched.
3. Escapes replacement values for their literal kind — backslash first, then the quote character; `${` in template literals (a live interpolation otherwise); `\r`, `\n`, and U+2028/U+2029 in quoted literals (a split literal otherwise). LLM-proposed text can never corrupt a source file.
4. Validates `expectedValue` (when set) against the current literal and throws on mismatch.

**Invariant:** `SourceLocation.line` and `SourceLocation.column` are 1-based package-wide — AST discovery, stack capture, and the writer all share the convention.

**Invariant:** The optimizer only emits entries for values that actually CHANGED, always sets `expectedValue`, and reports `writtenBack: true` only when at least one literal was written and nothing was skipped. `OptimizeResult.writeBackReport` exposes the per-entry outcome.

**Invariant:** The source writer only modifies string literals. It does not rewrite function bodies or control flow. L3 topology changes that require structural code modification are delegated to the pluggable coding agent.

### AST-Based Source Location Discovery

The optimizer needs to know WHERE in user source files each optimizable field lives so it can write changes back. Source locations are inferred automatically via TypeScript AST analysis — users never define them manually.

```typescript
function discoverFieldsFromSource(evalFilePath: string): OptimizableField[];
```

The static analysis module:
1. Takes an eval file path
2. Follows imports to find agent/step definition source files using TypeScript module resolution
3. Parses those imported source files into TypeScript ASTs (the eval file itself is excluded — only imported source modules are analyzed for builder calls)
4. Walks the AST to find builder calls (`step.llm()`, `tool()`, `react()`, `ralphWiggum()`, `branch()`, `fork()`, `spawn()`, `loop()`)
5. Extracts string literal values of optimizable fields (`instructions`, `description`, `name`) and their exact `SourceLocation` (file, line, column)
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

Adapters bridge third-party LLM SDKs into the eval system, allowing evaluation of agents built outside `@noetic-tools/core`.

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

When an `EvalSuiteConfig` includes an `adapter`, the eval runner calls `adapter.execute(input)` instead of `harness.run(step, input, ctx)`. Scorers receive the same `ScorerInput` shape regardless of whether the execution came from a native step or an adapter.

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

**Rationale:** The adapter layer means `@noetic/eval` is useful beyond the noetic ecosystem. Teams can adopt scored evaluation for any LLM application, then optionally migrate to `@noetic-tools/core` for the optimization features.

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
  /** False when any case regressed OR any baseline case is missing from the run. */
  passed: boolean;
  regressions: Array<{
    caseName: string;
    baselineScore: number;
    currentScore: number;
    delta: number;
  }>;
  /** Baseline case names absent from the current run (deleted, renamed, or never registered). */
  missingCases: string[];
  /** False when no baseline exists for the suite (the check is skipped, not failed). */
  baselineFound: boolean;
}

function checkRegression(
  currentResult: SuiteResult,
  maxRegression?: number, // default: 0.05
): Promise<RegressionResult>;
```

**Default tolerance:** `0.05` (5%). A case whose average score drops more than the tolerance is flagged as a regression.

**Reverse pass:** every baseline case must still exist in the current run. A vanished case (deleted, renamed — note dataset cases are named from the dataset path — or a registration bug running zero cases) is the maximal degradation and appears in `missingCases`; `passed` requires no regressions AND no missing cases.

### `--check` Flag

When `noetic test --check` is used:

1. Run all eval cases.
2. Load the baseline for each suite. A suite without a baseline prints a notice and is skipped (not failed).
3. Compare results against the baseline in both directions (score drops AND missing baseline cases).
4. Exit with code `1` if any regression is detected or any baseline case is missing from the run; print `REGRESSION`/`MISSING` lines per offending case.

This is designed for CI — the repo's `ci.yml` runs `noetic test --check` as a hard gate on `main` (PRs downgrade the failure to a `::warning`).

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
| `--watch` | `boolean` | `false` | Re-run evals when the eval files change (fresh subprocess per run) |
| `-u` | `boolean` | `false` | Run GEPA optimization after evaluation |
| `--scope` | `enum` | `prompts-only` | Optimization scope: `prompts-only`, `flow-structure`, or `full` |
| `--budget` | `number` | (none) | Maximum cost in dollars for the optimization run |
| `--dry-run` | `boolean` | `false` | Optimize without writing values back to source |
| `--save-baseline` | `boolean` | `false` | Save each suite's results as its regression baseline (`.noetic/baselines/<suite>.json`) |
| `--check` | `boolean` | `false` | Compare against saved baselines; exit `1` on regression or missing baseline case |

Unknown flags and invalid flag values (e.g. a typo'd `--scope` value) are usage errors: the CLI prints the problem and exits `2` — nothing is silently dropped or misread as a file pattern.

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Every case passed; under `--check`, no regressions and no missing baseline cases. Empty discovery without explicit patterns is OK; `--check` with no saved baseline prints a notice and passes. |
| `1` | Any failed/errored case, a `--check` regression or missing baseline case, an explicit file pattern that resolved to nothing, or an infrastructure error. `--save-baseline` with failing cases still saves, then exits `1`. |
| `2` | Usage error (unknown flag, invalid flag value). |

The CLI sets `process.exitCode` (never calls `process.exit()` mid-run), so in-flight writes flush before termination.

### Watch Mode

`--watch` runs each eval pass in a **fresh subprocess** (`[execPath, cliPath, ...argv-without---watch]`, stdio inherited). Re-importing eval files in-process is impossible: ESM dynamic `import()` is module-cached, so suite registration would never re-execute. Runs are serialized — file changes that land during a run coalesce into exactly one follow-up run, and children are never killed mid-run. The watcher reports each child's exit code but always exits `0` itself; child failures never terminate the watch loop. Only the eval files themselves are watched, not their transitive imports — restart the watcher after editing agent modules.

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

A case "fails" when any scorer returns a value below `0.5` (configurable via `EvalSuiteOptions.passThreshold`).

### Optimization via CLI

```
noetic test -u [--scope prompts-only|flow-structure|full] [--budget 5.00] [files...]
```

Runs the optimization pipeline after evaluation. The `--scope` flag controls the optimization level (L1 `prompts-only`, L2 `flow-structure`, L3 `full`). With `--dry-run`, nothing is written back to source.

---

## Cross-References

- `Step<I, O>` discriminated union is defined in `01-step-type`
- `step.run`, `step.llm`, `Tool` are defined in `02-step-variants`
- `branch`, `fork` are defined in `03-control-flow`
- `spawn` is defined in `04-spawn`
- `loop`, `until` are defined in `05-loop-and-until`
- `Context`, `Item`, `TokenUsage` are defined in `07-context-and-event-log`
- `AgentHarness`, `run` are defined in `08-agent-harness`
- `Span` is defined in `10-observability`
- `MemoryLayer` is defined in `11-memory-layer-system`
- `react`, `ralphWiggum` patterns are defined in `13-patterns`
