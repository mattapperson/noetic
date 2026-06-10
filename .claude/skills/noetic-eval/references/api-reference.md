# @noetic/eval API Reference

## Runner API

### `describe(step, options, fn)`

Registers an eval suite. The step is the first positional argument.

```typescript
function describe(
  step: DescribeStep,
  options: EvalSuiteOptions,
  fn: () => void,
): void;

// Accepts any Step<I, O> — no type widening needed by callers
type DescribeStep = {
  kind: Step['kind'];
  id: string;
};

interface EvalSuiteOptions {
  objective: string;
  passThreshold?: number;  // default: 0.5; cases pass when all scores >= threshold
  background?: string;
  optimize?: OptimizeConfig;
  regression?: RegressionConfig;
}
```

### `it(name, fn)`

Registers a test case within a `describe()` block.

```typescript
function it(name: string, fn: (ctx: EvalContext) => Promise<void>): void;
```

### `it.each(dataset, fn)`

Registers dataset-driven test cases. String datasets are JSONL files read at registration time.

```typescript
it.each<T>(
  dataset: string | T[],
  fn: (ctx: EvalContext & { example: T }) => Promise<void>,
): void;
```

### `EvalContext`

```typescript
interface EvalContext {
  execute(input: unknown): Promise<EvalExecution>;
  objective: string;
  background: string;
}
```

### `EvalExecution`

```typescript
interface EvalExecution {
  output: unknown;
  context: Context;
  traces: SpanImpl[];
  score(scorers: ScorerFn[]): Promise<ScoreResult[]>;
}
```

### `ScoreResult`

```typescript
interface ScoreResult {
  scorerId: string;
  score: number;          // 0.0 - 1.0
  reason?: string;
  metadata?: Record<string, unknown>;
}
```

## Scorer API

### `ScorerFn`

```typescript
type ScorerFn = (
  execution: EvalExecution,
  objective: string,
  background: string,
) => Promise<ScoreResult>;
```

### Built-in Scorers

All accessed via the `scorer` namespace:

```typescript
// Deterministic
scorer.latency({ target: number; maxAcceptable: number }): ScorerFn  // throws RangeError when maxAcceptable < target
scorer.cost({ budgetPerCall: number }): ScorerFn
scorer.tokenEfficiency({ maxOutputTokens: number }): ScorerFn
scorer.toolCallAccuracy({ expectedTools: string[]; strict?: boolean }): ScorerFn
scorer.fileExists({ paths: string[]; shouldNotExist?: string[]; contentMatches?: Record<string, RegExp> }): ScorerFn
scorer.custom(id: string, { generateScore, generateReason? }): ScorerFn

// LLM-judge (all accept optional { model?, callModel? })
scorer.answerRelevancy(config?): ScorerFn
scorer.answerSimilarity({ expected, threshold?, model?, callModel? }): ScorerFn  // threshold: binary gate (>= -> 1, else 0); raw judge score in metadata.rawScore
scorer.faithfulness({ context, model?, callModel? }): ScorerFn
scorer.hallucination({ context?, model?, callModel? }): ScorerFn
scorer.completeness(config?): ScorerFn
scorer.promptAlignment(config?): ScorerFn
scorer.toneConsistency({ target, model?, callModel? }): ScorerFn
scorer.toxicity({ threshold?, categories?, model?, callModel? }): ScorerFn  // judge scores NON-toxicity (1 = clean); threshold gates on it
scorer.bias({ categories?, model?, callModel? }): ScorerFn
scorer.contextPrecision(config?): ScorerFn
scorer.contextRelevance(config?): ScorerFn
scorer.fileReview({ path, instructions, model?, callModel? }): ScorerFn
scorer.directoryReview({ path, instructions, includeContents?, glob?, model?, callModel? }): ScorerFn
```

### `createScorer(config)`

4-step pipeline builder for custom scorers:

```typescript
createScorer({ id: string; judge?: { model: string; callModel?: CallModelFn } })
  .preprocess<T>(fn: ({ execution }) => T | Promise<T>)
  // Then either:
  .generateScore(fn: ({ results: T }) => number): PipelineStep4
  // Or with LLM analysis:
  .analyze<R>({ outputSchema: ZodType<R>; createPrompt: (data: T, objective: string) => string })
  .generateScore(fn: ({ results: R }) => number): PipelineStep4

// PipelineStep4 is callable as ScorerFn and has:
.generateReason({ createPrompt: (score: number) => string }): ScorerFn
```

### Score Clamping and Sanitization

Scorer pipelines (`createScorer`) automatically clamp scores outside [0, 1] to valid range; non-finite scores (`NaN`, `±Infinity`) become `0`. When clamped, the `ScoreResult` includes `metadata: { originalScore, clamped: true }`.

Independently, the runner sanitizes EVERY `ScoreResult` returned through `exec.score(...)` — including builtin scorers that bypass the pipeline — clamping finite values to [0, 1], mapping non-finite values to `0`, and recording the original in `metadata.sanitizedFrom`. Baselines therefore never contain `NaN` (which would serialize to `null` and break `loadBaseline`).

## Score Utilities

### `averageScores(scores)`

```typescript
function averageScores(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number;
```

### `medianScore(scores)`

```typescript
function medianScore(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number;
```

### `minScore(scores)`

```typescript
function minScore(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number;
```

### `maxScore(scores)`

```typescript
function maxScore(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number;
```

### `stddevScore(scores)`

```typescript
function stddevScore(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number;
```

## Optimization API

### `optimize(options)`

```typescript
function optimize(options: OptimizeOptions): Promise<OptimizeResult>;

interface OptimizeOptions {
  step: Step;
  scope: 'prompts-only' | 'flow-structure' | 'full';
  runEval: (step: Step) => Promise<Record<string, number>>;
  maxMetricCalls?: number;
  budget?: number;
  dryRun?: boolean;
  codingAgent?: CodingAgent;
  preEnrichedFields?: OptimizableField[];  // AST-enriched fields with source locations
  gepa?: GepaConfig;
}

interface OptimizeResult {
  fields: OptimizableField[];
  bestCandidate: Record<string, string>;
  score: number;
  iterations: number;
  // True only when >=1 source literal was actually rewritten AND no entry was
  // skipped. Only CHANGED values produce write-back entries, so an
  // optimization that found nothing better reports writtenBack: false.
  writtenBack: boolean;
  // Per-entry outcome (absent under dryRun or when nothing changed).
  writeBackReport?: WriteBackReport;
}

interface WriteBackReport {
  written: number;
  skipped: Array<{ sourceLocation: SourceLocation; reason: string }>;
}

interface GepaConfig {
  studentModel?: string;
  teacherModel?: string;
  numTrials?: number;
  earlyStoppingTrials?: number;
  verbose?: boolean;
}
```

### `discoverFields(step, prefix?, scope?)`

Walks a step tree to find optimizable text fields. Optionally filters by optimization scope.

```typescript
function discoverFields(
  step: Step,
  prefix?: string,
  scope?: 'prompts-only' | 'flow-structure' | 'full',
): OptimizableField[];

interface OptimizableField {
  path: string;
  value: string;
  stepId: string;
  fieldKind: 'system' | 'tool-description' | 'tool-name';
  sourceLocation?: SourceLocation;
}
```

### `discoverFieldsFromSource(evalFilePath)`

AST-based static analysis that parses TypeScript source files to discover optimizable fields with exact source locations.

```typescript
function discoverFieldsFromSource(evalFilePath: string): OptimizableField[];
```

Follows imports from the eval file, parses builder calls (`step.llm`, `tool`, `react`, `ralphWiggum`, etc.), and extracts `instructions`, `description`, `name` field values with their `SourceLocation`. `SourceLocation.line` and `.column` are 1-based package-wide (discovery, adapter stack capture, and the source writer all agree).

### `enrichWithSourceLocations(runtimeFields, astFields)`

Merges runtime-discovered fields with AST-discovered source locations.

```typescript
function enrichWithSourceLocations(
  runtimeFields: OptimizableField[],
  astFields: OptimizableField[],
): OptimizableField[];
```

Matches by `stepId` + `fieldKind` + `value` and copies `sourceLocation` from AST fields to runtime fields.

### `applyCandidate(step, candidate)`

Deep-clones a step tree with field replacements from a candidate map.

```typescript
function applyCandidate(step: Step, candidate: Record<string, string>, prefix?: string): Step;
```

## Regression API

### `saveBaseline(suiteResult)`

```typescript
function saveBaseline(suiteResult: SuiteResult): Promise<string>;  // returns file path
```

### `loadBaseline(suiteName)`

```typescript
function loadBaseline(suiteName: string): Promise<Baseline | null>;
```

### `checkRegression(currentResult, maxRegression?)`

```typescript
function checkRegression(
  currentResult: SuiteResult,
  maxRegression?: number,  // default: 0.05
): Promise<RegressionResult>;

interface RegressionResult {
  // False when any case regressed OR any baseline case is missing from the run.
  passed: boolean;
  regressions: Array<{
    caseName: string;
    baselineScore: number;
    currentScore: number;
    delta: number;
  }>;
  // Baseline case names absent from the current run (deleted/renamed/never registered).
  missingCases: string[];
  // False when no baseline exists (check skipped, not failed).
  baselineFound: boolean;
}
```

## Adapter API

### `createAdapter(config)`

```typescript
function createAdapter(config: AdapterConfig): Record<string, (...args: unknown[]) => unknown>;

interface AdapterConfig {
  provider: string;
  wrap: Record<string, (...args: unknown[]) => unknown>;
  fields?: Record<string, FieldMapping>;
  skill?: string;
}
```

## Running Evals in bun test

```typescript
import { clearSuites, getSuites, runAllSuites } from '@noetic/eval';

// Each test should clearSuites() first (global registry is shared)
clearSuites();
await import('./my-agent.eval');
const results = await runAllSuites(getSuites());

// Check all cases passed
for (const suite of results) {
  for (const c of suite.cases) {
    if (!c.passed) throw new Error(`"${c.name}" failed: ${c.error}`);
  }
}
```
