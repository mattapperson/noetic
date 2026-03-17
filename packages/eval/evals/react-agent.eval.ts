import { react, tool } from '@noetic/core';
import {
  createScriptedCallModel,
  textOnlyResponse,
  toolCallResponse,
} from '@noetic/core/test/_helpers';
import { z } from 'zod';

import { describe, it, scorer } from '../src';

//#region Tools

const searchTool = tool({
  name: 'search',
  description: 'Search for information',
  input: z.object({
    query: z.string(),
  }),
  output: z.string(),
  execute: async (args) => `Results for: ${args.query}`,
});

const calculatorTool = tool({
  name: 'calculator',
  description: 'Perform arithmetic',
  input: z.object({
    expression: z.string(),
  }),
  output: z.string(),
  execute: async (_args) => '42',
});

//#endregion

//#region Single Tool Use

describe({
  step: react({
    model: 'test/scripted',
    system: 'You are a helpful assistant with search capabilities.',
    tools: [
      searchTool,
    ],
    maxSteps: 5,
  }),
  callModel: createScriptedCallModel([
    toolCallResponse({
      toolName: 'search',
      args: JSON.stringify({
        query: 'TypeScript agent frameworks',
      }),
      output: 'Results for: TypeScript agent frameworks',
      finalText: 'I found information about TypeScript agent frameworks.',
    }),
    textOnlyResponse('Based on my search, TypeScript agent frameworks include Noetic.'),
  ]),
}, {
  objective: 'Correctly uses search tool and synthesizes results',
}, () => {
  it('searches and responds', async (ctx) => {
    const exec = await ctx.execute('What are some TypeScript agent frameworks?');
    await exec.score([
      scorer.latency({
        target: 100,
        maxAcceptable: 5e3,
      }),
      scorer.custom('has-output', {
        generateScore: (e) => (typeof e.output === 'string' && e.output.length > 0 ? 1.0 : 0.0),
        generateReason: (_, s) => (s === 1.0 ? 'Output is non-empty string' : 'Empty output'),
      }),
    ]);
  });
});

//#endregion

//#region Multi-Tool Orchestration

describe({
  step: react({
    model: 'test/scripted',
    system: 'You are a research assistant with search and calculator tools.',
    tools: [
      searchTool,
      calculatorTool,
    ],
    maxSteps: 10,
  }),
  callModel: createScriptedCallModel([
    toolCallResponse({
      toolName: 'search',
      args: JSON.stringify({
        query: 'population of France',
      }),
      output: 'Results for: population of France',
      finalText: 'Let me calculate based on that.',
    }),
    toolCallResponse({
      toolName: 'calculator',
      args: JSON.stringify({
        expression: '67000000 / 551695',
      }),
      output: '42',
      finalText: 'Done calculating.',
    }),
    textOnlyResponse('The population density of France is approximately 121 per km².'),
  ]),
}, {
  objective: 'Uses multiple tools in sequence to answer a complex question',
}, () => {
  it('chains search then calculator', async (ctx) => {
    const exec = await ctx.execute('What is the population density of France?');
    await exec.score([
      scorer.latency({
        target: 200,
        maxAcceptable: 1e4,
      }),
      scorer.custom('multi-tool-used', {
        generateScore: (e) => {
          const output = String(e.output);
          return output.length > 0 ? 1.0 : 0.0;
        },
      }),
    ]);
  });
});

//#endregion

//#region No Tool Needed

describe({
  step: react({
    model: 'test/scripted',
    system: 'You are a helpful assistant.',
    tools: [
      searchTool,
    ],
    maxSteps: 5,
  }),
  callModel: createScriptedCallModel([
    textOnlyResponse('Hello! How can I help you today?'),
  ]),
}, {
  objective: 'Responds directly without tools when appropriate',
}, () => {
  it('responds without tool calls for greetings', async (ctx) => {
    const exec = await ctx.execute('Hello!');
    await exec.score([
      scorer.latency({
        target: 50,
        maxAcceptable: 2e3,
      }),
      scorer.custom('direct-response', {
        generateScore: (e) => (typeof e.output === 'string' && e.output.length > 0 ? 1.0 : 0.0),
      }),
    ]);
  });
});

//#endregion
