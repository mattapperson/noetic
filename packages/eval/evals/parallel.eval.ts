import { fork, spawn, step } from '@noetic/core';

import { describe, it, scorer } from '../src';

//#region Perspective Steps

const technicalAnalysis = spawn({
  id: 'technical-spawn',
  child: step.run({
    id: 'technical-analysis',
    execute: async (input: unknown): Promise<unknown> =>
      `Technical perspective on "${input}": Strong type system needed.`,
  }),
});

const businessAnalysis = spawn({
  id: 'business-spawn',
  child: step.run({
    id: 'business-analysis',
    execute: async (input: unknown): Promise<unknown> =>
      `Business perspective on "${input}": Market demand is high.`,
  }),
});

const userAnalysis = spawn({
  id: 'user-spawn',
  child: step.run({
    id: 'user-analysis',
    execute: async (input: unknown): Promise<unknown> =>
      `User perspective on "${input}": Simplicity is key.`,
  }),
});

//#endregion

//#region Fork All - Parallel Research

const parallelResearch = fork({
  id: 'parallel-research',
  mode: 'all',
  paths: () => [
    technicalAnalysis,
    businessAnalysis,
    userAnalysis,
  ],
  merge: (results): unknown => results.join('\n---\n'),
});

describe({
  step: parallelResearch,
}, {
  objective: 'Runs all perspectives in parallel and merges results',
}, () => {
  it('gathers all three perspectives', async (ctx) => {
    const exec = await ctx.execute('Should we build an agent framework?');
    await exec.score([
      scorer.latency({
        target: 50,
        maxAcceptable: 2e3,
      }),
      scorer.custom('all-perspectives', {
        generateScore: (e) => {
          const output = String(e.output);
          const hasTechnical = output.includes('Technical perspective');
          const hasBusiness = output.includes('Business perspective');
          const hasUser = output.includes('User perspective');
          if (hasTechnical && hasBusiness && hasUser) {
            return 1.0;
          }
          const count = [
            hasTechnical,
            hasBusiness,
            hasUser,
          ].filter(Boolean).length;
          return count / 3;
        },
        generateReason: (e, s) =>
          `${Math.round(s * 3)}/3 perspectives present in output (${String(e.output).length} chars)`,
      }),
    ]);
  });
});

//#endregion

//#region Fork Race - First Responder

const raceResearch = fork({
  id: 'race-research',
  mode: 'race',
  paths: () => [
    step.run({
      id: 'fast-responder',
      execute: async (input: unknown): Promise<unknown> => `Fast answer: ${input}`,
    }),
    step.run({
      id: 'slow-responder',
      execute: async (input: unknown): Promise<unknown> => {
        await new Promise((r) => setTimeout(r, 100));
        return `Slow answer: ${input}`;
      },
    }),
  ],
});

describe({
  step: raceResearch,
}, {
  objective: 'Returns the first completed result in race mode',
}, () => {
  it('returns fastest responder', async (ctx) => {
    const exec = await ctx.execute('Quick question');
    await exec.score([
      scorer.latency({
        target: 20,
        maxAcceptable: 500,
      }),
      scorer.custom('has-result', {
        generateScore: (e) => (typeof e.output === 'string' && e.output.length > 0 ? 1.0 : 0.0),
      }),
    ]);
  });
});

//#endregion

//#region Fork Settle - Error Tolerant

const settleResearch = fork({
  id: 'settle-research',
  mode: 'settle',
  paths: () => [
    step.run({
      id: 'success-path',
      execute: async (input: unknown): Promise<unknown> => `Success: ${input}`,
    }),
    step.run({
      id: 'failure-path',
      execute: async (): Promise<unknown> => {
        throw new Error('Simulated failure');
      },
    }),
  ],
  merge: (results): unknown => {
    const successes = results.filter((r) => r.status === 'fulfilled');
    return successes.map((r) => String(r.value)).join('; ');
  },
});

describe({
  step: settleResearch,
}, {
  objective: 'Handles partial failures gracefully in settle mode',
}, () => {
  it('captures both success and failure results', async (ctx) => {
    const exec = await ctx.execute('Test settle mode');
    await exec.score([
      scorer.custom('graceful-partial', {
        generateScore: (e) => {
          const output = String(e.output);
          return output.includes('Success') ? 1.0 : 0.0;
        },
        generateReason: (e) => `Output: ${String(e.output).slice(0, 80)}`,
      }),
    ]);
  });
});

//#endregion
