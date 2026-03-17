import { ralphWiggum, tool } from '@noetic/core';
import { z } from 'zod';

import { describe, it, scorer } from '../src';

//#region Tools

const writeFileTool = tool({
  name: 'write_file',
  description: 'Write content to a file at the given path',
  input: z.object({
    path: z.string(),
    content: z.string(),
  }),
  output: z.string(),
  execute: async (args) => `Wrote ${args.content.length} bytes to ${args.path}`,
});

const readFileTool = tool({
  name: 'read_file',
  description: 'Read the contents of a file at the given path',
  input: z.object({
    path: z.string(),
  }),
  output: z.string(),
  execute: async (args) => `Contents of ${args.path}: // placeholder`,
});

//#endregion

//#region Verify Helpers

function createVerifier(requiredPatterns: string[]): (output: unknown) => Promise<{
  pass: boolean;
  feedback?: string;
}> {
  return async (output: unknown) => {
    const outputStr = String(output).toLowerCase();
    const missing = requiredPatterns.filter((p) => !outputStr.includes(p));
    if (missing.length === 0) {
      return {
        pass: true,
      };
    }
    return {
      pass: false,
      feedback: `Missing required elements: ${missing.join(', ')}. Please revise.`,
    };
  };
}

//#endregion

//#region Converges on First Try

describe(ralphWiggum({
  model: 'anthropic/claude-sonnet-4-20250514',
  system: 'You are a code writer. Write clean, working TypeScript code. Use the write_file tool.',
  tools: [
    writeFileTool,
    readFileTool,
  ],
  verify: createVerifier([
    'wrote',
  ]),
  maxIterations: 3,
  innerMaxSteps: 6,
}), {
  objective: 'Produces correct code output on first iteration without retries',
}, () => {
  it('writes a hello world script', async (ctx) => {
    const exec = await ctx.execute('Write a hello world TypeScript script to index.ts');
    await exec.score([
      scorer.latency({
        target: 1e4,
        maxAcceptable: 6e4,
      }),
      scorer.cost({
        budgetPerCall: 0.15,
      }),
      scorer.custom('has-output', {
        generateScore: (e) => (typeof e.output === 'string' && e.output.length > 0 ? 1.0 : 0.0),
        generateReason: (_, s) => (s === 1.0 ? 'Agent produced output' : 'Empty output'),
      }),
    ]);
  });
});

//#endregion

//#region Converges After Feedback

const feedbackCounter = {
  count: 0,
};

describe(ralphWiggum({
  model: 'anthropic/claude-sonnet-4-20250514',
  system:
    'You are a code writer. Follow feedback to improve your code. Use the write_file tool to write files.',
  tools: [
    writeFileTool,
    readFileTool,
  ],
  verify: async (_output) => {
    feedbackCounter.count++;
    if (feedbackCounter.count <= 1) {
      return {
        pass: false,
        feedback: 'Missing error handling. Add try/catch blocks around async operations.',
      };
    }
    return {
      pass: true,
    };
  },
  maxIterations: 5,
  innerMaxSteps: 6,
}), {
  objective: 'Incorporates verification feedback to converge on a correct solution',
}, () => {
  it('improves code after feedback', async (ctx) => {
    feedbackCounter.count = 0;
    const exec = await ctx.execute('Write a fetch wrapper with proper error handling to api.ts');
    await exec.score([
      scorer.latency({
        target: 1.5e4,
        maxAcceptable: 9e4,
      }),
      scorer.cost({
        budgetPerCall: 0.3,
      }),
      scorer.custom('converged', {
        generateScore: (e) => (typeof e.output === 'string' && e.output.length > 0 ? 1.0 : 0.0),
      }),
      scorer.custom('iterated', {
        generateScore: () => (feedbackCounter.count >= 2 ? 1.0 : 0.0),
        generateReason: (_, s) =>
          s === 1.0 ? 'Correctly iterated after feedback' : 'Did not iterate',
      }),
    ]);
  });
});

//#endregion

//#region Tool Accuracy

describe(ralphWiggum({
  model: 'anthropic/claude-sonnet-4-20250514',
  system: 'You are a code writer. Always use write_file to produce output.',
  tools: [
    writeFileTool,
    readFileTool,
  ],
  verify: createVerifier([
    'wrote',
  ]),
  maxIterations: 3,
  innerMaxSteps: 6,
}), {
  objective: 'Uses the write_file tool accurately to produce code files',
}, () => {
  it('uses write_file tool', async (ctx) => {
    const exec = await ctx.execute('Create a utils.ts file with a debounce function');
    await exec.score([
      scorer.custom('produced-output', {
        generateScore: (e) => (typeof e.output === 'string' && e.output.length > 0 ? 1.0 : 0.0),
      }),
      scorer.cost({
        budgetPerCall: 0.2,
      }),
    ]);
  });
});

//#endregion
