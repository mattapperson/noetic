---
name: noetic-eval
description: This skill provides guidance for writing evaluations, scored tests, and optimizations for Noetic agents using the @noetic-tools/eval package. Use when creating .eval.ts files, defining scorers, running noetic-eval, or optimizing step compositions. Triggers include mentions of "eval", "scorer", "benchmark", "evaluate", "noetic-eval", "noetic test", "optimize prompts", "GEPA", "baseline", "regression", or any @noetic-tools/eval API usage.
---

# Evaluating Agents with @noetic-tools/eval

`@noetic-tools/eval` provides scored evaluation and optimization for Noetic step compositions. It lets you define test suites that execute steps, score their outputs, and optionally optimize prompts via GEPA.

## Core Concepts

### Everything is a Suite

Evals are organized into suites via `describe()`. Each suite wraps an `AgentHarness.run` call (step + harness config) and evaluates it against an objective:

```typescript
import { describe, it, scorer } from '@noetic-tools/eval';
import { react } from '@noetic-tools/core';

const agent = react({
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'You are a support agent.',
  tools: myTools,
  maxSteps: 10,
});

describe(
  agent,
  { objective: 'Classifies and resolves customer issues accurately', passThreshold: 0.5 },
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
2. Creates `AgentHarness({ traceExporter })` — the agent harness auto-detects `callModel` from `OPENROUTER_API_KEY`
3. Creates context and calls `harness.run(step, input, ctx)`
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
| `scorer.latency({ target, maxAcceptable })` | ms thresholds (`maxAcceptable < target` throws `RangeError`) | `ctx.elapsed` |
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
| `scorer.answerSimilarity({ expected, threshold? })` | Semantic similarity to expected answer; `threshold` turns the score into a binary gate (raw judge score kept in `metadata.rawScore`) |
| `scorer.faithfulness({ context })` | Stays within provided context |
| `scorer.hallucination({ context? })` | Detects fabricated content |
| `scorer.completeness()` | Fully addresses the objective |
| `scorer.promptAlignment()` | Follows system prompt instructions |
| `scorer.toneConsistency({ target })` | Matches target tone |
| `scorer.toxicity({ threshold?, categories? })` | Detects toxic content; the judge scores NON-toxicity (1.0 = clean) and `threshold` gates on it (>= threshold -> 1) |
| `scorer.bias({ categories? })` | Detects bias |
| `scorer.contextPrecision()` | Precision of context usage |
| `scorer.contextRelevance()` | Relevance of retrieved context |
| `scorer.fileReview({ path, instructions })` | Reviews file against instructions |
| `scorer.directoryReview({ path, instructions })` | Reviews directory structure |

### Custom Scorer Pipeline

```typescript
import { createScorer } from '@noetic-tools/eval';

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
noetic-eval                        # Run all *.eval.ts files
noetic-eval support-agent          # Run specific file
noetic-eval --verbose              # Per-scorer breakdown
noetic-eval --json > results.json  # Machine-readable output
noetic-eval --watch                # Re-run on changes

noetic-eval -u                     # Optimize (GEPA)
noetic-eval -u --scope full        # Full program optimization
noetic-eval -u --budget 10         # Cost cap
noetic-eval -u --dry-run           # Preview without writing

noetic-eval --save-baseline        # Save scores as regression baseline
noetic-eval --check                # Fail if scores regress or baseline cases vanish
```

Exit codes: `0` all cases passed (clean `--check`; no-baseline `--check` prints a notice and passes), `1` any failed/errored case, regression, missing baseline case, or unresolvable explicit file pattern, `2` usage error (unknown flag, invalid `--scope`/`--budget` value — never silently dropped).

Watch mode spawns a fresh subprocess per run (in-process re-import is module-cached and would never re-register suites), serializes runs, coalesces changes during a run into one follow-up, and always exits `0` itself. Only the eval files are watched, not transitive imports.

## Optimization

### How It Works

1. **Field Discovery** -- walks the step tree to find optimizable text (system prompts, tool descriptions/names). Accepts an optional `scope` parameter to filter by optimization level.
2. **AST Source Discovery** -- parses imported source files (not the eval file itself) to find exact source locations of optimizable fields. Follows variable references to declarations.
3. **GEPA Bridge** -- implements an `AxGEPAAdapter` from `@ax-llm/ax`. AxGEPA keys candidates by component id, so the bridge carries all noetic field values in one instruction component as marker-delimited blocks (`=== NOETIC FIELD <path> === ... === END NOETIC FIELD ===`), discovers the component id via `getOptimizableComponents()`, and implements `propose_new_texts` so the teacher improves each field individually while the bridge preserves the marker structure. `evaluate()` parses the candidate text and scores the MUTATED step; corrupted text fails closed to the original values. The best candidate is the argmax-average pareto point.
4. **Source Writer** -- writes optimized values back to source files at tracked 1-based locations. Only CHANGED values are written, the current value is validated (`expectedValue`) before writing, and replacement text is escaped per literal kind (`${` in backticks; newlines/U+2028/29 in quoted strings). Returns a `WriteBackReport { written, skipped[] }`; `OptimizeResult.writtenBack` is true only when something was written and nothing was skipped.

### GepaConfig

```typescript
interface GepaConfig {
  studentModel?: string;     // Default: 'openai/gpt-4o-mini'
  teacherModel?: string;     // Default: 'openai/gpt-4o'
  numTrials?: number;        // Default: 5
  earlyStoppingTrials?: number; // Default: 3
  verbose?: boolean;
}
```

### Optimization Levels

| Level | Scope | What Changes |
|-------|-------|--------------|
| 1 | `prompts-only` | System prompts, tool descriptions |
| 2 | `flow-structure` | L1 + tool names |
| 3 | `full` | All fields + structural changes via coding agent |

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
noetic-eval --save-baseline   # Save current scores
noetic-eval --check           # Exit 1 if a score drops > threshold OR a baseline case is missing
```

`--check` also fails (exit 1) when a case present in the baseline is absent from the run — deleting or renaming cases cannot silently green the gate. Suites without a saved baseline print a notice and pass.

## Adapters (Third-Party SDKs)

```typescript
import { createAdapter } from '@noetic-tools/eval';
import { VERCEL_AI_MAPPINGS } from '@noetic-tools/eval/adapters/field-mappings/vercel-ai';

const adapted = createAdapter({
  provider: 'vercel-ai',
  wrap: { streamText, generateText },
  fields: VERCEL_AI_MAPPINGS,
});
```

## How to Write an Eval

### Step 1: Create the File

Create `<name>.eval.ts` anywhere in your project. Import your agent step and `@noetic-tools/eval`.

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
noetic-eval
```

### Running Evals as Tests

To run eval suites as part of `bun test`, import the `.eval.ts` file in a test and use `runAllSuites`:

```typescript
import { clearSuites, getSuites, runAllSuites } from '@noetic-tools/eval';

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
