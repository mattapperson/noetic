import { branch, step } from '@noetic/core';

import { describe, it, scorer } from '../src';

//#region Route Handlers

const billingHandler = step.run({
  id: 'billing-handler',
  execute: async (input: unknown): Promise<unknown> => `[billing] Handling: ${input}`,
});

const technicalHandler = step.run({
  id: 'technical-handler',
  execute: async (input: unknown): Promise<unknown> => `[technical] Handling: ${input}`,
});

const generalHandler = step.run({
  id: 'general-handler',
  execute: async (input: unknown): Promise<unknown> => `[general] Handling: ${input}`,
});

//#endregion

//#region Keyword Router

const keywordRouter = branch({
  id: 'keyword-router',
  route: (input: unknown) => {
    const lower = String(input).toLowerCase();
    if (lower.includes('bill') || lower.includes('charge') || lower.includes('payment')) {
      return billingHandler;
    }
    if (lower.includes('error') || lower.includes('bug') || lower.includes('crash')) {
      return technicalHandler;
    }
    return generalHandler;
  },
});

//#endregion

//#region Routes to Billing

describe({
  step: keywordRouter,
}, {
  objective: 'Routes billing-related queries to the billing handler',
}, () => {
  it.each(
    [
      {
        input: 'I was double-charged on my bill',
        expectedTag: '[billing]',
      },
      {
        input: 'My payment failed',
        expectedTag: '[billing]',
      },
      {
        input: 'Can you refund the charge?',
        expectedTag: '[billing]',
      },
    ],
    async (ctx) => {
      const exec = await ctx.execute(ctx.example.input);
      await exec.score([
        scorer.custom('correct-route', {
          generateScore: (e) => (String(e.output).includes(ctx.example.expectedTag) ? 1.0 : 0.0),
          generateReason: (e) =>
            `Output "${String(e.output).slice(0, 50)}" ${String(e.output).includes(ctx.example.expectedTag) ? 'contains' : 'missing'} ${ctx.example.expectedTag}`,
        }),
      ]);
    },
  );
});

//#endregion

//#region Routes to Technical

describe({
  step: keywordRouter,
}, {
  objective: 'Routes technical queries to the technical handler',
}, () => {
  it.each(
    [
      {
        input: 'The app keeps crashing on startup',
        expectedTag: '[technical]',
      },
      {
        input: 'I found a bug in the dashboard',
        expectedTag: '[technical]',
      },
      {
        input: 'Getting an error when I login',
        expectedTag: '[technical]',
      },
    ],
    async (ctx) => {
      const exec = await ctx.execute(ctx.example.input);
      await exec.score([
        scorer.custom('correct-route', {
          generateScore: (e) => (String(e.output).includes(ctx.example.expectedTag) ? 1.0 : 0.0),
        }),
      ]);
    },
  );
});

//#endregion

//#region Falls Through to General

describe({
  step: keywordRouter,
}, {
  objective: 'Routes unrecognized queries to the general handler',
}, () => {
  it.each(
    [
      {
        input: 'How do I change my username?',
        expectedTag: '[general]',
      },
      {
        input: 'What are your business hours?',
        expectedTag: '[general]',
      },
    ],
    async (ctx) => {
      const exec = await ctx.execute(ctx.example.input);
      await exec.score([
        scorer.custom('correct-route', {
          generateScore: (e) => (String(e.output).includes(ctx.example.expectedTag) ? 1.0 : 0.0),
        }),
        scorer.latency({
          target: 10,
          maxAcceptable: 1e3,
        }),
      ]);
    },
  );
});

//#endregion
