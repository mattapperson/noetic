import { react, tool } from '@noetic-tools/core';
import { z } from 'zod';

import { describe, it, scorer } from '../src';

//#region Tools

const lookupOrderTool = tool({
  name: 'lookup_order',
  description: 'Look up a customer order by order ID',
  input: z.object({
    orderId: z.string(),
  }),
  output: z.string(),
  execute: async (args) =>
    JSON.stringify({
      orderId: args.orderId,
      status: 'shipped',
      total: '$49.99',
      eta: '2026-03-20',
    }),
});

const refundTool = tool({
  name: 'issue_refund',
  description: 'Issue a refund for a given order',
  input: z.object({
    orderId: z.string(),
    reason: z.string(),
  }),
  output: z.string(),
  execute: async (args) => `Refund issued for order ${args.orderId}: ${args.reason}`,
});

//#endregion

//#region Support Agent

const supportAgent = react({
  model: 'anthropic/claude-sonnet-4',
  instructions:
    'You are a customer support agent. Use the available tools to look up orders and issue refunds when appropriate. Be helpful and concise.',
  tools: [
    lookupOrderTool,
    refundTool,
  ],
  maxSteps: 8,
});

//#endregion

//#region Order Lookup

describe(supportAgent, {
  objective: 'Looks up order details and reports status accurately',
}, () => {
  it('looks up an order and reports status', async (ctx) => {
    const exec = await ctx.execute('Where is my order #12345?');
    await exec.score([
      scorer.latency({
        target: 5e3,
        maxAcceptable: 3e4,
      }),
      scorer.cost({
        budgetPerCall: 0.05,
      }),
      scorer.custom('has-output', {
        generateScore: (e) => (typeof e.output === 'string' && e.output.length > 0 ? 1.0 : 0.0),
        generateReason: (_, s) => (s === 1.0 ? 'Agent produced output' : 'Empty output'),
      }),
    ]);
  });
});

//#endregion

//#region Refund Request

describe(supportAgent, {
  objective: 'Handles refund requests by looking up the order and issuing a refund',
}, () => {
  it('processes a refund request', async (ctx) => {
    const exec = await ctx.execute('I need a refund for order #99887 — the item arrived damaged.');
    await exec.score([
      scorer.latency({
        target: 5e3,
        maxAcceptable: 3e4,
      }),
      scorer.cost({
        budgetPerCall: 0.1,
      }),
      scorer.custom('mentions-refund', {
        generateScore: (e) => {
          const output = String(e.output).toLowerCase();
          return output.includes('refund') ? 1.0 : 0.0;
        },
        generateReason: (_, s) =>
          s === 1.0 ? 'Output mentions refund' : 'Output does not mention refund',
      }),
    ]);
  });
});

//#endregion

//#region Direct Response

describe(supportAgent, {
  objective: 'Responds directly to greetings without unnecessary tool calls',
}, () => {
  it('greets without tool use', async (ctx) => {
    const exec = await ctx.execute('Hello, I just wanted to say thanks!');
    await exec.score([
      scorer.latency({
        target: 3e3,
        maxAcceptable: 1.5e4,
      }),
      scorer.custom('has-response', {
        generateScore: (e) => (typeof e.output === 'string' && e.output.length > 0 ? 1.0 : 0.0),
      }),
    ]);
  });
});

//#endregion
