import { ralphWiggum, tool } from '@noetic/core';
import {
  createScriptedCallModel,
  textOnlyResponse,
  toolCallResponse,
} from '@noetic/core/test/_helpers';
import { z } from 'zod';

import { describe, it, scorer } from '../src';

//#region Tools

const writeTool = tool({
  name: 'write_file',
  description: 'Write content to a file',
  input: z.object({
    path: z.string(),
    content: z.string(),
  }),
  output: z.string(),
  execute: async (args) => `Wrote ${args.content.length} bytes to ${args.path}`,
});

//#endregion

//#region Converges on First Try

describe({
  step: ralphWiggum({
    model: 'test/scripted',
    system: 'You are a code writer. Write clean code.',
    tools: [
      writeTool,
    ],
    verify: async (_output) => ({
      pass: true,
    }),
    maxIterations: 3,
    innerMaxSteps: 5,
  }),
  callModel: createScriptedCallModel([
    toolCallResponse({
      toolName: 'write_file',
      args: JSON.stringify({
        path: 'index.ts',
        content: 'console.log("hello")',
      }),
      output: 'Wrote 20 bytes to index.ts',
      finalText: 'I wrote the file.',
    }),
    textOnlyResponse('Done writing the file.'),
  ]),
}, {
  objective: 'Produces correct output on first iteration without needing retries',
}, () => {
  it('passes verification on first attempt', async (ctx) => {
    const exec = await ctx.execute('Write a hello world script');
    await exec.score([
      scorer.latency({
        target: 200,
        maxAcceptable: 5e3,
      }),
      scorer.custom('first-try-success', {
        generateScore: (e) => (typeof e.output === 'string' && e.output.length > 0 ? 1.0 : 0.0),
      }),
    ]);
  });
});

//#endregion

//#region Converges After Feedback

let verifyCallCount = 0;

describe({
  step: ralphWiggum({
    model: 'test/scripted',
    system: 'You are a code writer. Follow feedback to improve.',
    tools: [
      writeTool,
    ],
    verify: async (_output) => {
      verifyCallCount++;
      if (verifyCallCount <= 1) {
        return {
          pass: false,
          feedback: 'Missing error handling. Add try/catch.',
        };
      }
      return {
        pass: true,
      };
    },
    maxIterations: 5,
    innerMaxSteps: 5,
  }),
  callModel: createScriptedCallModel([
    // First iteration: writes without error handling
    toolCallResponse({
      toolName: 'write_file',
      args: JSON.stringify({
        path: 'index.ts',
        content: 'fetch("/api")',
      }),
      output: 'Wrote 13 bytes to index.ts',
      finalText: 'Written.',
    }),
    textOnlyResponse('First attempt done.'),
    // Second iteration: adds try/catch after feedback
    toolCallResponse({
      toolName: 'write_file',
      args: JSON.stringify({
        path: 'index.ts',
        content: 'try { fetch("/api") } catch(e) { console.error(e) }',
      }),
      output: 'Wrote 52 bytes to index.ts',
      finalText: 'Added error handling.',
    }),
    textOnlyResponse('Improved with try/catch.'),
  ]),
}, {
  objective: 'Incorporates verification feedback to converge on a correct solution',
}, () => {
  it('improves after feedback', async (ctx) => {
    verifyCallCount = 0;
    const exec = await ctx.execute('Write a fetch call with proper error handling');
    await exec.score([
      scorer.latency({
        target: 500,
        maxAcceptable: 1e4,
      }),
      scorer.custom('converged', {
        generateScore: (e) => (typeof e.output === 'string' && e.output.length > 0 ? 1.0 : 0.0),
      }),
      scorer.custom('needed-iteration', {
        generateScore: () => (verifyCallCount >= 2 ? 1.0 : 0.0),
        generateReason: (_, s) =>
          s === 1.0 ? 'Correctly iterated after feedback' : 'Did not iterate',
      }),
    ]);
  });
});

//#endregion
