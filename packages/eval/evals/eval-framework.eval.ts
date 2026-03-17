import { step } from '@noetic/core';

import { createScorer, describe, it, scorer } from '../src';

//#region Test Steps

const echoStep = step.run({
  id: 'echo',
  execute: async (input: unknown) => input,
});

const slowStep = step.run({
  id: 'slow-echo',
  execute: async (input: unknown) => {
    await new Promise((r) => setTimeout(r, 50));
    return input;
  },
});

const jsonStep = step.run({
  id: 'json-producer',
  execute: async (input: unknown) =>
    JSON.stringify({
      answer: input,
      confidence: 0.95,
    }),
});

//#endregion

//#region Latency Scorer Accuracy

describe({
  step: echoStep,
}, {
  objective: 'Latency scorer returns high score for fast execution',
}, () => {
  it('scores fast step near 1.0', async (ctx) => {
    const exec = await ctx.execute('quick');
    await exec.score([
      scorer.latency({
        target: 1e3,
        maxAcceptable: 5e3,
      }),
      scorer.custom('latency-high', {
        generateScore: async (e) => {
          const [latencyResult] = await e.score([
            scorer.latency({
              target: 1e3,
              maxAcceptable: 5e3,
            }),
          ]);
          return latencyResult.score >= 0.9 ? 1.0 : 0.0;
        },
        generateReason: (_, s) =>
          s === 1.0 ? 'Latency scorer correctly scored fast step high' : 'Latency score too low',
      }),
    ]);
  });
});

describe({
  step: slowStep,
}, {
  objective: 'Latency scorer degrades for slower execution',
}, () => {
  it('scores slow step lower than fast step', async (ctx) => {
    const exec = await ctx.execute('slow');
    await exec.score([
      scorer.latency({
        target: 10,
        maxAcceptable: 200,
      }),
      scorer.custom('latency-degraded', {
        generateScore: async (e) => {
          const [latencyResult] = await e.score([
            scorer.latency({
              target: 10,
              maxAcceptable: 200,
            }),
          ]);
          return latencyResult.score < 1.0 ? 1.0 : 0.0;
        },
      }),
    ]);
  });
});

//#endregion

//#region Custom Scorer Pipeline

const jsonFormatScorer = createScorer({
  id: 'json-format',
})
  .preprocess(({ execution }) => String(execution.output))
  .generateScore(({ results }) => {
    try {
      JSON.parse(results);
      return 1.0;
    } catch {
      return 0.0;
    }
  });

describe({
  step: jsonStep,
}, {
  objective: 'Custom scorer pipeline correctly validates JSON output format',
}, () => {
  it('scores valid JSON as 1.0', async (ctx) => {
    const exec = await ctx.execute('test input');
    await exec.score([
      jsonFormatScorer,
      scorer.custom('pipeline-validates', {
        generateScore: async (e) => {
          const [result] = await e.score([
            jsonFormatScorer,
          ]);
          return result.score === 1.0 ? 1.0 : 0.0;
        },
      }),
    ]);
  });
});

describe({
  step: echoStep,
}, {
  objective: 'Custom scorer pipeline rejects non-JSON output',
}, () => {
  it('scores plain text as 0.0', async (ctx) => {
    const exec = await ctx.execute('not json at all');
    await exec.score([
      jsonFormatScorer,
      scorer.custom('pipeline-rejects', {
        generateScore: async (e) => {
          const [result] = await e.score([
            jsonFormatScorer,
          ]);
          return result.score === 0.0 ? 1.0 : 0.0;
        },
      }),
    ]);
  });
});

//#endregion

//#region Cost Scorer

describe({
  step: echoStep,
}, {
  objective: 'Cost scorer returns 1.0 when cost is within budget',
}, () => {
  it('scores zero-cost step as 1.0', async (ctx) => {
    const exec = await ctx.execute('free');
    await exec.score([
      scorer.cost({
        budgetPerCall: 0.01,
      }),
      scorer.custom('cost-within-budget', {
        generateScore: async (e) => {
          const [costResult] = await e.score([
            scorer.cost({
              budgetPerCall: 0.01,
            }),
          ]);
          return costResult.score === 1.0 ? 1.0 : 0.0;
        },
      }),
    ]);
  });
});

//#endregion

//#region Scorer Composition

describe({
  step: echoStep,
}, {
  objective: 'Multiple scorers run independently and produce separate results',
}, () => {
  it('returns correct number of score results', async (ctx) => {
    const exec = await ctx.execute('multi-score test');
    const scores = await exec.score([
      scorer.latency({
        target: 1e3,
        maxAcceptable: 5e3,
      }),
      scorer.cost({
        budgetPerCall: 0.1,
      }),
      scorer.custom('echo-check', {
        generateScore: (e) => (e.output === 'multi-score test' ? 1.0 : 0.0),
      }),
    ]);
    await exec.score([
      scorer.custom('scorer-count', {
        generateScore: () => (scores.length === 3 ? 1.0 : 0.0),
        generateReason: (_, s) =>
          s === 1.0 ? 'All 3 scorers produced results' : `Expected 3, got ${scores.length}`,
      }),
    ]);
  });
});

//#endregion
