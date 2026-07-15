# @noetic/eval

Eval framework for [Noetic](https://github.com/mattapperson/noetic) agents.

Write eval suites the way you write tests: `describe` an agent, `it` over
examples, and `score` each execution with composable scorers. Suites run against
real agents (`react`, `step`, any `Step`), so what you measure is what ships.

- **Suite runner** — `describe` / `it` / `it.each` with a per-example
  `EvalContext` that executes the agent and scores the result.
- **Scorers** — built-ins (LLM judge, answer relevancy/similarity, faithfulness,
  hallucination, bias, completeness, context precision/relevance, tool-call
  accuracy, prompt alignment, token efficiency, cost, latency, file/directory
  review) plus `scorer.custom()` for your own.
- **Regression baselines** — save a baseline, then fail CI when scores drop.
- **Optimization** — `optimize()` improves prompt fields against your own evals,
  backed by GEPA, and can write the winning values back to source.

## Install

```bash
bun add -d @noetic/eval
```

`optimize()`'s GEPA backend needs the optional peer `@ax-llm/ax`; install it only
if you use optimization. The rest of the package works without it.

```bash
bun add -d @ax-llm/ax
```

## Write a suite

```ts
import { react } from '@noetic-tools/core';
import { describe, it, scorer } from '@noetic/eval';

const agent = react({
  model: 'anthropic/claude-sonnet-4',
  instructions: 'You are a ticket routing agent...',
  tools: [classifyTool, escalateTool],
  maxSteps: 6,
});

describe(agent, { objective: 'Routes billing tickets to the billing category' }, () => {
  it.each(
    [
      { input: 'I was double-charged on my last invoice', expectedCategory: 'billing' },
      { input: 'Can I get a refund for the overcharge?', expectedCategory: 'billing' },
    ],
    async (ctx) => {
      const exec = await ctx.execute(ctx.example.input);
      await exec.score([
        scorer.custom('classified-correctly', {
          generateScore: (e) =>
            String(e.output).toLowerCase().includes(ctx.example.expectedCategory) ? 1.0 : 0.0,
        }),
        scorer.latency({ target: 5e3, maxAcceptable: 3e4 }),
      ]);
    },
  );
});
```

## Run

```bash
noetic-eval                     # run every *.eval.ts suite
noetic-eval --watch             # re-run on change
noetic-eval --json              # machine-readable results
noetic-eval --save-baseline     # record current scores
noetic-eval --check             # fail if scores regress from the baseline
noetic-eval --scope <scope> --budget <n>   # optimization run
```

## License

Apache-2.0
