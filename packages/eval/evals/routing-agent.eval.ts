import { react, tool } from '@noetic/core';
import { z } from 'zod';

import { describe, it, scorer } from '../src';

//#region Tools

const classifyTool = tool({
  name: 'classify_ticket',
  description: 'Classify a support ticket into a category: billing, technical, or general',
  input: z.object({
    ticket: z.string(),
    category: z.string(),
  }),
  output: z.string(),
  execute: async (args) => `Classified as: ${args.category}`,
});

const escalateTool = tool({
  name: 'escalate',
  description: 'Escalate a ticket to a human agent with a priority level',
  input: z.object({
    ticket: z.string(),
    priority: z.string(),
  }),
  output: z.string(),
  execute: async (args) => `Escalated with priority: ${args.priority}`,
});

//#endregion

//#region Routing Agent

const routingAgent = react({
  model: 'anthropic/claude-sonnet-4-20250514',
  system:
    'You are a ticket routing agent. Classify incoming tickets using the classify_ticket tool. Escalate urgent tickets using the escalate tool. Always classify before deciding whether to escalate.',
  tools: [
    classifyTool,
    escalateTool,
  ],
  maxSteps: 6,
});

//#endregion

//#region Billing Tickets

describe(routingAgent, {
  objective: 'Routes billing-related tickets to the billing category',
}, () => {
  it.each(
    [
      {
        input: 'I was double-charged on my last invoice',
        expectedCategory: 'billing',
      },
      {
        input: 'My payment method was declined but I have funds',
        expectedCategory: 'billing',
      },
      {
        input: 'Can I get a refund for the overcharge on my account?',
        expectedCategory: 'billing',
      },
    ],
    async (ctx) => {
      const exec = await ctx.execute(ctx.example.input);
      await exec.score([
        scorer.custom('classified-correctly', {
          generateScore: (e) => {
            const output = String(e.output).toLowerCase();
            return output.includes(ctx.example.expectedCategory) ? 1.0 : 0.0;
          },
          generateReason: (e, s) =>
            s === 1.0
              ? `Output contains "${ctx.example.expectedCategory}"`
              : `Expected "${ctx.example.expectedCategory}" in: ${String(e.output).slice(0, 80)}`,
        }),
        scorer.latency({
          target: 5e3,
          maxAcceptable: 3e4,
        }),
      ]);
    },
  );
});

//#endregion

//#region Technical Tickets

describe(routingAgent, {
  objective: 'Routes technical issues to the technical category',
}, () => {
  it.each(
    [
      {
        input: 'The API returns 500 errors when I POST to /users',
        expectedCategory: 'technical',
      },
      {
        input: 'App crashes on startup after the latest update',
        expectedCategory: 'technical',
      },
    ],
    async (ctx) => {
      const exec = await ctx.execute(ctx.example.input);
      await exec.score([
        scorer.custom('classified-correctly', {
          generateScore: (e) => {
            const output = String(e.output).toLowerCase();
            return output.includes(ctx.example.expectedCategory) ? 1.0 : 0.0;
          },
        }),
        scorer.cost({
          budgetPerCall: 0.05,
        }),
      ]);
    },
  );
});

//#endregion

//#region Urgent Escalation

describe(routingAgent, {
  objective: 'Escalates urgent tickets with appropriate priority',
}, () => {
  it('escalates a data breach report', async (ctx) => {
    const exec = await ctx.execute(
      'URGENT: We discovered unauthorized access to customer data. This needs immediate attention.',
    );
    await exec.score([
      scorer.custom('was-escalated', {
        generateScore: (e) => {
          const output = String(e.output).toLowerCase();
          return output.includes('escalat') || output.includes('priority') ? 1.0 : 0.0;
        },
        generateReason: (_, s) => (s === 1.0 ? 'Ticket was escalated' : 'Ticket was not escalated'),
      }),
      scorer.latency({
        target: 5e3,
        maxAcceptable: 3e4,
      }),
    ]);
  });
});

//#endregion
