import type { PlanNode } from '@noetic/core';
import { compilePlan, step } from '@noetic/core';

import { describe, it, scorer } from '../src';

//#region Agent Factories

const agents: Record<string, (prompt: string) => ReturnType<typeof step.run>> = {
  researcher: (prompt: string) =>
    step.run({
      id: `researcher-${prompt.slice(0, 10)}`,
      execute: async (input: unknown) => `Researched: ${prompt} with input ${String(input)}`,
    }),
  writer: (prompt: string) =>
    step.run({
      id: `writer-${prompt.slice(0, 10)}`,
      execute: async (input: unknown) => `Written: ${prompt} from ${String(input)}`,
    }),
  reviewer: (prompt: string) =>
    step.run({
      id: `reviewer-${prompt.slice(0, 10)}`,
      execute: async (input: unknown) => `Reviewed: ${prompt} on ${String(input)}`,
    }),
};

//#endregion

//#region Sequential Plan

const sequentialPlan: PlanNode = {
  id: 'root',
  description: 'Write a blog post',
  assignee: 'writer',
  execution: 'sequential',
  children: [
    {
      id: 'research',
      description: 'Research the topic',
      assignee: 'researcher',
      execution: 'sequential',
    },
    {
      id: 'draft',
      description: 'Write the draft',
      assignee: 'writer',
      execution: 'sequential',
    },
    {
      id: 'review',
      description: 'Review the draft',
      assignee: 'reviewer',
      execution: 'sequential',
    },
  ],
};

describe({
  step: compilePlan<string>(sequentialPlan, agents),
}, {
  objective: 'Executes sequential plan nodes in order, passing output through the chain',
}, () => {
  it('chains research → write → review', async (ctx) => {
    const exec = await ctx.execute('Write about TypeScript agents');
    await exec.score([
      scorer.latency({
        target: 50,
        maxAcceptable: 2e3,
      }),
      scorer.custom('sequential-output', {
        generateScore: (e) => {
          const output = String(e.output);
          return output.includes('Reviewed') ? 1.0 : 0.0;
        },
        generateReason: (e) => `Final output: ${String(e.output).slice(0, 80)}`,
      }),
    ]);
  });
});

//#endregion

//#region Parallel Plan

const parallelPlan: PlanNode = {
  id: 'root',
  description: 'Multi-perspective research',
  assignee: 'researcher',
  execution: 'parallel',
  children: [
    {
      id: 'perspective-a',
      description: 'Research from technical angle',
      assignee: 'researcher',
      execution: 'sequential',
    },
    {
      id: 'perspective-b',
      description: 'Research from business angle',
      assignee: 'researcher',
      execution: 'sequential',
    },
  ],
};

describe({
  step: compilePlan<string>(parallelPlan, agents),
}, {
  objective: 'Executes parallel plan branches concurrently and merges results',
}, () => {
  it('runs parallel research branches', async (ctx) => {
    const exec = await ctx.execute('Research AI agent patterns');
    await exec.score([
      scorer.latency({
        target: 50,
        maxAcceptable: 2e3,
      }),
      scorer.custom('parallel-completed', {
        generateScore: (e) => (e.output !== undefined && e.output !== null ? 1.0 : 0.0),
      }),
    ]);
  });
});

//#endregion

//#region Leaf Node Plan

const leafPlan: PlanNode = {
  id: 'single-task',
  description: 'Write a summary',
  assignee: 'writer',
  execution: 'sequential',
};

describe({
  step: compilePlan<string>(leafPlan, agents),
}, {
  objective: 'Executes a single leaf node plan directly',
}, () => {
  it('runs a single agent task', async (ctx) => {
    const exec = await ctx.execute('Summarize the findings');
    await exec.score([
      scorer.latency({
        target: 20,
        maxAcceptable: 1e3,
      }),
      scorer.custom('leaf-output', {
        generateScore: (e) => {
          const output = String(e.output);
          return output.includes('Written') ? 1.0 : 0.0;
        },
      }),
    ]);
  });
});

//#endregion
