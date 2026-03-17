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
scorer.latency({ target: number; maxAcceptable: number }): ScorerFn
scorer.cost({ budgetPerCall: number }): ScorerFn
scorer.tokenEfficiency({ maxOutputTokens: number }): ScorerFn
scorer.toolCallAccuracy({ expectedTools: string[]; strict?: boolean }): ScorerFn
scorer.fileExists({ paths: string[]; shouldNotExist?: string[]; contentMatches?: Record<string, RegExp> }): ScorerFn
scorer.custom(id: string, { generateScore, generateReason? }): ScorerFn

// LLM-judge (all accept optional { model?, callModel? })
scorer.answerRelevancy(config?): ScorerFn
scorer.answerSimilarity({ expected, threshold?, model?, callModel? }): ScorerFn
scorer.faithfulness({ context, model?, callModel? }): ScorerFn
scorer.hallucination({ context?, model?, callModel? }): ScorerFn
scorer.completeness(config?): ScorerFn
scorer.promptAlignment(config?): ScorerFn
scorer.toneConsistency({ target, model?, callModel? }): ScorerFn
scorer.toxicity({ threshold?, categories?, model?, callModel? }): ScorerFn
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
}

interface OptimizeResult {
  fields: OptimizableField[];
  bestCandidate: Record<string, string>;
  score: number;
  iterations: number;
  writtenBack: boolean;
}
```

### `discoverFields(step)`

Walks a step tree to find optimizable text fields.

```typescript
function discoverFields(step: Step, prefix?: string): OptimizableField[];

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

Follows imports from the eval file, parses builder calls (`step.llm`, `tool`, `react`, `ralphWiggum`, etc.), and extracts `system`, `description`, `name` field values with their `SourceLocation`.

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
  passed: boolean;
  regressions: Array<{
    caseName: string;
    baselineScore: number;
    currentScore: number;
    delta: number;
  }>;
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
