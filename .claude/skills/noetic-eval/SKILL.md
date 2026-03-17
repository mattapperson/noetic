---
name: noetic-eval
description: This skill provides guidance for writing evaluations, scored tests, and optimizations for Noetic agents using the @noetic/eval package. Use when creating .eval.ts files, defining scorers, running noetic test, or optimizing step compositions. Triggers include mentions of "eval", "scorer", "benchmark", "evaluate", "noetic test", "optimize prompts", "GEPA", "baseline", "regression", or any @noetic/eval API usage.
---

# Evaluating Agents with @noetic/eval

`@noetic/eval` provides scored evaluation and optimization for Noetic step compositions. It lets you define test suites that execute steps, score their outputs, and optionally optimize prompts via GEPA.

## Core Concepts

### Everything is a Suite

Evals are organized into suites via `describe()`. Each suite wraps a `Runtime.execute` call (step + runtime config) and evaluates it against an objective:

```typescript
import { describe, it, scorer } from '@noetic/eval';
import { react } from '@noetic/core';

const agent = react({
  model: 'anthropic/claude-sonnet-4-20250514',
  system: 'You are a support agent.',
  tools: myTools,
  maxSteps: 10,
});

describe(
  agent,
  { objective: 'Classifies and resolves customer issues accurately' },
  () => {
    it('classifies billing issues', async (ctx) => {
      const exec = await ctx.execute('I was double-charged');
      await exec.score([
        scorer.answerRelevancy(),
        scorer.completeness(),
        scorer.latency({ target: 2e3, maxAcceptable: 1e4 }),
      ]);
    });

    it('handles angry customers', async (ctx) => {
      const exec = await ctx.execute('This is unacceptable!');
      await exec.score([
        scorer.toneConsistency({ target: 'empathetic' }),
        scorer.toxicity(),
      ]);
    });
  },
);
```

### How describe() Works

When `ctx.execute(input)` is called inside an `it()` block:

1. Creates a fresh `InMemoryExporter` for trace capture
2. Creates `InMemoryRuntime({ traceExporter })` — the runtime auto-detects `callModel` from `OPENROUTER_API_KEY`
3. Creates context and calls `runtime.execute(step, input, ctx)`
4. Returns `EvalExecution` with output, context metrics, and traces

### The EvalExecution Object

```typescript
interface EvalExecution {
  output: unknown;           // Step return value
  context: Context;          // Has .elapsed, .cost, .tokens, .lastStepMeta
  traces: SpanImpl[];        // Captured trace spans
  score(scorers: ScorerFn[]): Promise<ScoreResult[]>;  // Run scorers in parallel
}
```

### Dataset-Driven Tests

```typescript
// Inline array
it.each([
  { input: 'billing question', expected: 'billing' },
  { input: 'tech issue', expected: 'technical' },
], async (ctx) => {
  const exec = await ctx.execute(ctx.example.input);
  await exec.score([
    scorer.answerSimilarity({ expected: ctx.example.expected }),
  ]);
});

// JSONL file (read once at registration time)
it.each('test/fixtures/tickets.jsonl', async (ctx) => {
  const exec = await ctx.execute(ctx.example.query);
  await exec.score([scorer.completeness()]);
});
```

## Scorer System

### Deterministic Scorers (no LLM)

| Scorer | Config | Score Source |
|--------|--------|-------------|
| `scorer.latency({ target, maxAcceptable })` | ms thresholds | `ctx.elapsed` |
| `scorer.cost({ budgetPerCall })` | dollar amount | `ctx.cost` |
| `scorer.tokenEfficiency({ maxOutputTokens })` | token count | `ctx.tokens.output` |
| `scorer.toolCallAccuracy({ expectedTools, strict? })` | tool names | `ctx.lastStepMeta.toolCalls` |
| `scorer.fileExists({ paths, shouldNotExist?, contentMatches? })` | file paths | filesystem |
| `scorer.custom(id, { generateScore, generateReason? })` | inline fn | user-defined |

### LLM-Judge Scorers (dogfood Noetic)

All accept optional `{ model?, callModel? }` config:

| Scorer | What It Judges |
|--------|---------------|
| `scorer.answerRelevancy()` | Output relevance to objective |
| `scorer.answerSimilarity({ expected })` | Semantic similarity to expected answer |
| `scorer.faithfulness({ context })` | Stays within provided context |
| `scorer.hallucination({ context? })` | Detects fabricated content |
| `scorer.completeness()` | Fully addresses the objective |
| `scorer.promptAlignment()` | Follows system prompt instructions |
| `scorer.toneConsistency({ target })` | Matches target tone |
| `scorer.toxicity({ threshold?, categories? })` | Detects toxic content |
| `scorer.bias({ categories? })` | Detects bias |
| `scorer.contextPrecision()` | Precision of context usage |
| `scorer.contextRelevance()` | Relevance of retrieved context |
| `scorer.fileReview({ path, instructions })` | Reviews file against instructions |
| `scorer.directoryReview({ path, instructions })` | Reviews directory structure |

### Custom Scorer Pipeline

```typescript
import { createScorer } from '@noetic/eval';

const myScorer = createScorer({ id: 'format-check' })
  .preprocess(({ execution }) => String(execution.output))
  .generateScore(({ results }) => results.startsWith('{') ? 1.0 : 0.0);
```

With LLM analysis step:

```typescript
const qualityScorer = createScorer({
  id: 'quality',
  judge: { model: 'anthropic/claude-sonnet-4-20250514', callModel },
})
  .preprocess(({ execution }) => ({
    output: String(execution.output),
    toolCalls: execution.context.lastStepMeta?.toolCalls ?? [],
  }))
  .analyze({
    outputSchema: z.object({ quality: z.number(), reasoning: z.string() }),
    createPrompt: (data, objective) =>
      `Rate the quality of this output for: ${objective}\n\nOutput: ${data.output}`,
  })
  .generateScore(({ results }) => results.quality)
  .generateReason({ createPrompt: (score) => `Quality: ${score}` });
```

## CLI

```bash
noetic test                        # Run all *.eval.ts files
noetic test support-agent          # Run specific file
noetic test --verbose              # Per-scorer breakdown
noetic test --json > results.json  # Machine-readable output
noetic test --watch                # Re-run on changes

noetic test -u                     # Optimize (GEPA)
noetic test -u --scope full        # Full program optimization
noetic test -u --budget 10         # Cost cap
noetic test -u --dry-run           # Preview without writing

noetic test --save-baseline        # Save scores as regression baseline
noetic test --check                # Fail if scores regress
```

## Optimization

### How It Works

1. **Field Discovery** -- walks the step tree to find optimizable text (system prompts, tool descriptions/names)
2. **AST Source Discovery** -- parses imported source files (not the eval file itself) to find exact source locations of optimizable fields
3. **GEPA Bridge** -- maps fields to AxGEPA candidates, runs eval as the metric function
4. **Source Writer** -- writes optimized values back to source files at tracked locations

### Optimization Levels

| Level | Scope | What Changes |
|-------|-------|--------------|
| 1 | `prompts-only` | System prompts, tool descriptions |
| 2 | `flow-structure` | L1 + routing logic, composition |
| 3 | `full` | Full program optimization (requires coding agent) |

### Annotating Dynamic Steps

`branch` and `fork` steps have dynamic children (functions). Annotate them for the optimizer:

```typescript
const router = branch({
  id: 'router',
  route: (input, ctx) => { /* dynamic routing */ },
  _optimizable: [billingAgent, techSupportAgent],
});
```

## Regression Testing

```typescript
describe(step, {
  objective: '...',
  regression: {
    baseline: '.noetic/baselines/my-suite.json',
    maxRegression: 0.05,
    createBaselineIfMissing: true,
  },
}, () => { /* ... */ });
```

Save and check:
```bash
noetic test --save-baseline   # Save current scores
noetic test --check           # Fail if score drops > threshold
```

## Adapters (Third-Party SDKs)

```typescript
import { createAdapter } from '@noetic/eval';
import { VERCEL_AI_MAPPINGS } from '@noetic/eval/adapters/field-mappings/vercel-ai';

const adapted = createAdapter({
  provider: 'vercel-ai',
  wrap: { streamText, generateText },
  fields: VERCEL_AI_MAPPINGS,
});
```

## How to Write an Eval

### Step 1: Create the File

Create `<name>.eval.ts` anywhere in your project. Import your agent step and `@noetic/eval`.

### Step 2: Define the Suite

Use `describe(step, { objective }, fn)` with the step as the first positional argument. LLM access is auto-configured via `OPENROUTER_API_KEY` — the eval context has zero knowledge of `callModel`.

`describe()` accepts steps with any `I`/`O` type parameters — no need to widen types or cast. Steps of type `Step<string, string>`, `Step<unknown, unknown>`, etc. all work directly.

### Step 3: Write Test Cases

Each `it()` block calls `ctx.execute(input)` and scores the result. Choose scorers based on what matters:

- **Correctness**: `answerRelevancy`, `answerSimilarity`, `completeness`
- **Safety**: `toxicity`, `bias`, `hallucination`
- **Efficiency**: `latency`, `cost`, `tokenEfficiency`
- **Behavior**: `toolCallAccuracy`, `promptAlignment`, `toneConsistency`

### Step 4: Run

```bash
noetic test
```

### Running Evals as Tests

To run eval suites as part of `bun test`, import the `.eval.ts` file in a test and use `runAllSuites`:

```typescript
import { clearSuites, getSuites, runAllSuites } from '@noetic/eval';

clearSuites();
await import('./my-agent.eval');
const results = await runAllSuites(getSuites());
```

### Common Pitfalls

- **Missing `OPENROUTER_API_KEY`**: Evals using LLM steps will fail without the env var set
- **`compilePlan` with mixed execution**: Nested plans mixing sequential and parallel require `executeStep` — pure eval context cannot execute `fork` steps inside sequential chains without it
- **Verify return type**: The `ralphWiggum` verify function must return `{ pass: boolean; feedback?: string }` (note: `pass`, not `passed`)

## Source Locations

| Concept | Source Path |
|---------|------------|
| Runner | `packages/eval/src/runner/` |
| Scorers | `packages/eval/src/scorers/` |
| Optimization | `packages/eval/src/optimization/` |
| CLI | `packages/eval/src/cli/` |
| Types | `packages/eval/src/types/` |
| Adapters | `packages/eval/src/adapters/` |
| Regression | `packages/eval/src/regression/` |
| Spec | `specs/17-eval-and-optimization.md` |
