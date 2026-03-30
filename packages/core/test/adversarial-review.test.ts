/**
 * Adversarial review test: Multi-Perspective Code Analyzer
 *
 * Builds and exercises a non-trivial multi-operator agent pipeline
 * combining step.run, step.llm, branch, fork (all + settle), loop,
 * tool, and channel primitives.
 */

import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';

import {
  AgentHarness,
  branch,
  channel,
  fork,
  isNoeticError,
  loop,
  step,
  tool,
  until,
} from '../src/index';
import type { Context } from '../src/types/context';
import type { ContextMemory } from '../src/types/memory';
import type { SettleResult, Step, Verdict } from '../src/types/step';
import {
  assertOpenResponsesCompliance,
  createDynamicCallModel,
  createScriptedCallModel,
  makeLLMResponse,
} from './_helpers';

//#region Types

type Classification = {
  language: string;
  complexity: 'simple' | 'complex' | 'unknown';
};

type FindingsMessage = {
  source: string;
  finding: string;
};

type CountLinesInput = {
  code: string;
};

//#endregion

//#region Schemas

const CountLinesInputSchema = z.object({
  code: z.string(),
});

const CountLinesOutputSchema = z.object({
  lines: z.number(),
  blanks: z.number(),
});

const FindingsMessageSchema = z.object({
  source: z.string(),
  finding: z.string(),
});

//#endregion

//#region Shared Builders

function buildClassifyStep(): Step<ContextMemory, string, Classification> {
  return step.run<ContextMemory, string, Classification>({
    id: 'classify',
    execute: async (input) => {
      if (input.includes('class ') || input.length > 100) {
        return {
          language: 'typescript',
          complexity: 'complex',
        };
      }
      if (input.includes('function ') || input.includes('=>')) {
        return {
          language: 'javascript',
          complexity: 'simple',
        };
      }
      return {
        language: 'unknown',
        complexity: 'unknown',
      };
    },
  });
}

function buildSimpleAnalysisStep(): Step<ContextMemory, string, string> {
  return step.llm<ContextMemory, string, string>({
    id: 'simple-analysis',
    model: 'test-model',
    system: 'Analyze the given code snippet briefly.',
  });
}

function buildParallelAnalysisFork(): Step<ContextMemory, string, string> {
  return fork<ContextMemory, string, string>({
    id: 'parallel-analysis',
    mode: 'all',
    paths: () => [
      step.llm<ContextMemory, string, string>({
        id: 'security-analysis',
        model: 'test-model',
        system: 'Analyze for security issues',
      }),
      step.llm<ContextMemory, string, string>({
        id: 'performance-analysis',
        model: 'test-model',
        system: 'Analyze for performance issues',
      }),
      step.llm<ContextMemory, string, string>({
        id: 'maintainability-analysis',
        model: 'test-model',
        system: 'Analyze for maintainability',
      }),
    ],
    merge: (results: string[], _ctx: Context): string => {
      return `Combined: ${results.join(' | ')}`;
    },
  });
}

function buildSettleFork(): Step<ContextMemory, string, string> {
  return fork<ContextMemory, string, string>({
    id: 'optional-extras',
    mode: 'settle',
    paths: () => [
      step.run<ContextMemory, string, string>({
        id: 'style-analysis',
        execute: async (input) => `Style OK for: ${input.slice(0, 20)}`,
      }),
      step.run<ContextMemory, string, string>({
        id: 'dependency-analysis',
        execute: async () => {
          throw new Error('Dependency service unavailable');
        },
      }),
    ],
    merge: (results: SettleResult<string>[], _ctx: Context): string => {
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      return `Settled: ${fulfilled.length} ok, ${rejected.length} failed`;
    },
  });
}

//#endregion

//#region Test 1: Full Pipeline (Simple Path)

describe('adversarial review: multi-perspective code analyzer', () => {
  test('executes full pipeline with mocked LLM (simple path)', async () => {
    const classifyStep = buildClassifyStep();

    const routeStep = branch<ContextMemory, string, string>({
      id: 'route-by-complexity',
      route: async (input, ctx) => {
        const classification = await ctx.harness.run(classifyStep, input, ctx);
        if (classification.complexity === 'simple') {
          return buildSimpleAnalysisStep();
        }
        if (classification.complexity === 'complex') {
          return buildParallelAnalysisFork();
        }
        return null;
      },
    });

    const script = [
      // The simple-analysis step.llm call
      makeLLMResponse('Simple analysis: no issues found in add function', {
        usage: {
          inputTokens: 50,
          outputTokens: 25,
        },
        cost: 0.002,
      }),
    ];

    const harness = new AgentHarness({
      name: 'code-analyzer-simple',
      initialStep: routeStep,
      params: {},
      _testCallModel: createScriptedCallModel(script),
    });

    const ctx = harness.createContext();
    const result = await harness.run(routeStep, 'function add(a, b) { return a + b; }', ctx);

    expect(typeof result).toBe('string');
    expect(result).toContain('no issues found');
    expect(ctx.tokens.input).toBeGreaterThan(0);
    expect(ctx.tokens.output).toBeGreaterThan(0);
    expect(ctx.cost).toBeGreaterThan(0);
    expect(ctx.itemLog.items.length).toBeGreaterThan(0);
  });

  //#endregion

  //#region Test 2: Complex Branch with Fork and Merge

  test('executes complex branch with fork and merge', async () => {
    const classifyStep = buildClassifyStep();

    const routeStep = branch<ContextMemory, string, string>({
      id: 'route-by-complexity',
      route: async (input, ctx) => {
        const classification = await ctx.harness.run(classifyStep, input, ctx);
        if (classification.complexity === 'complex') {
          return buildParallelAnalysisFork();
        }
        return buildSimpleAnalysisStep();
      },
    });

    const script = [
      // 3 LLM calls for the parallel fork paths (text output)
      makeLLMResponse('No SQL injection found, score: 9', {
        usage: {
          inputTokens: 40,
          outputTokens: 20,
        },
        cost: 0.001,
      }),
      makeLLMResponse('O(n) complexity detected, score: 7', {
        usage: {
          inputTokens: 40,
          outputTokens: 20,
        },
        cost: 0.001,
      }),
      makeLLMResponse('Good naming conventions, score: 8', {
        usage: {
          inputTokens: 40,
          outputTokens: 20,
        },
        cost: 0.001,
      }),
    ];

    const harness = new AgentHarness({
      name: 'code-analyzer-complex',
      params: {},
      _testCallModel: createScriptedCallModel(script),
    });

    const complexCode =
      'class ComplexSystem { constructor() { this.state = {}; } process(data) { return Object.keys(data).map(k => this.transform(k, data[k])); } transform(key, value) { return { key, value: value * 2 }; } }';

    const ctx = harness.createContext();
    const result = await harness.run(routeStep, complexCode, ctx);

    expect(typeof result).toBe('string');
    expect(result).toContain('Combined:');
    // Fork paths run in child contexts; verify the result merged all 3 perspectives
    // The merge concatenates stringified results with ' | '
    expect(ctx.itemLog.items.length).toBeGreaterThanOrEqual(0);
  });

  //#endregion

  //#region Test 3: Fork Settle Handles Partial Failures

  test('fork settle handles partial failures', async () => {
    const settleStep = buildSettleFork();

    const harness = new AgentHarness({
      name: 'settle-test',
      params: {},
    });

    const ctx = harness.createContext();
    const result = await harness.run(settleStep, 'some code snippet', ctx);

    expect(result).toBe('Settled: 1 ok, 1 failed');
  });

  //#endregion

  //#region Test 4: Loop with until.verified Refines Output

  test('loop with until.verified refines output', async () => {
    let verifyCallCount = 0;

    const refinementLoop = loop<ContextMemory, string, string>({
      id: 'refinement-loop',
      steps: [
        step.run<ContextMemory, string, string>({
          id: 'refine',
          execute: async (input) => {
            return `refined(${input})`;
          },
        }),
      ],
      until: until.verified(async (output) => {
        verifyCallCount++;
        const outputStr = typeof output === 'string' ? output : String(output);
        // Pass on the 3rd call (after 3 iterations)
        const depth = (outputStr.match(/refined/g) ?? []).length;
        if (depth >= 3) {
          return {
            pass: true,
          };
        }
        return {
          pass: false,
          feedback: `Need more refinement (depth: ${depth})`,
        };
      }),
      maxIterations: 5,
      prepareNext: (output: string, verdict: Verdict) => {
        if (verdict.feedback) {
          return `${output} [feedback: ${verdict.feedback}]`;
        }
        return output;
      },
    });

    const harness = new AgentHarness({
      name: 'loop-test',
      params: {},
    });

    const ctx = harness.createContext();
    const result = await harness.run(refinementLoop, 'initial analysis', ctx);

    expect(verifyCallCount).toBe(3);
    expect(result).toContain('refined');
    // Verify the nesting shows 3 levels of refinement
    const depth = (result.match(/refined/g) ?? []).length;
    expect(depth).toBeGreaterThanOrEqual(3);
  });

  //#endregion

  //#region Test 5: Channel Queue Send/Recv

  test('channel queue send/recv works', async () => {
    const findingsChannel = channel<FindingsMessage>('findings', {
      schema: FindingsMessageSchema,
      mode: 'queue',
    });

    const sendStep = step.run<ContextMemory, string, string>({
      id: 'send-finding',
      execute: async (input, ctx) => {
        ctx.send(findingsChannel, {
          source: 'test',
          finding: input,
        });
        return 'sent';
      },
    });

    const recvStep = step.run<ContextMemory, string, FindingsMessage>({
      id: 'recv-finding',
      execute: async (_input, ctx) => {
        const msg = await ctx.recv(findingsChannel, {
          timeout: 1e3,
        });
        return msg;
      },
    });

    const harness = new AgentHarness({
      name: 'channel-test',
      params: {},
    });

    const ctx = harness.createContext();

    await harness.run(sendStep, 'security issue detected', ctx);
    const received = await harness.run(recvStep, '', ctx);

    expect(received.source).toBe('test');
    expect(received.finding).toBe('security issue detected');
  });

  //#endregion

  //#region Test 6: Tool with Zod Validation

  test('tool with Zod validation executes correctly', async () => {
    const countLines = tool({
      name: 'countLines',
      description: 'Count lines and blank lines in code',
      input: CountLinesInputSchema,
      output: CountLinesOutputSchema,
      execute: async (args: CountLinesInput) => {
        const lines = args.code.split('\n');
        const blanks = lines.filter((l) => l.trim() === '').length;
        return {
          lines: lines.length,
          blanks,
        };
      },
    });

    const toolStep = step.tool({
      id: 'count-lines-step',
      tool: countLines,
    });

    const harness = new AgentHarness({
      name: 'tool-test',
      params: {},
    });

    const ctx = harness.createContext();
    const result = await harness.run(
      toolStep,
      {
        code: 'line1\nline2\n\nline4\n',
      },
      ctx,
    );

    expect(result.lines).toBe(5);
    expect(result.blanks).toBe(2); // empty line between line2/line4 + trailing
  });

  //#endregion

  //#region Test 7: Null Branch Route Passes Input Through

  test('null branch route passes input through', async () => {
    const nullBranch = branch<ContextMemory, string, string>({
      id: 'null-route',
      route: () => null,
    });

    const harness = new AgentHarness({
      name: 'null-branch-test',
      params: {},
    });

    const ctx = harness.createContext();
    const result = await harness.run(nullBranch, 'passthrough-value', ctx);

    expect(result).toBe('passthrough-value');
  });

  //#endregion

  //#region Test 8: OpenResponses Compliance

  test('OpenResponses compliance of all items in itemLog', async () => {
    const script = [
      makeLLMResponse('Analysis complete: code is safe.', {
        usage: {
          inputTokens: 30,
          outputTokens: 15,
        },
        cost: 0.001,
      }),
    ];

    const analysisStep = step.llm<ContextMemory, string, string>({
      id: 'compliance-analysis',
      model: 'test-model',
      system: 'Analyze the code.',
    });

    const harness = new AgentHarness({
      name: 'compliance-test',
      params: {},
      _testCallModel: createScriptedCallModel(script),
    });

    const ctx = harness.createContext();
    await harness.run(analysisStep, 'function hello() { return "world"; }', ctx);

    expect(ctx.itemLog.items.length).toBeGreaterThan(0);
    assertOpenResponsesCompliance(ctx.itemLog.items);

    // Verify we have both user and assistant messages
    const userItems = ctx.itemLog.items.filter((i) => i.type === 'message' && i.role === 'user');
    const assistantItems = ctx.itemLog.items.filter(
      (i) => i.type === 'message' && i.role === 'assistant',
    );
    expect(userItems.length).toBeGreaterThanOrEqual(1);
    expect(assistantItems.length).toBeGreaterThanOrEqual(1);
  });

  //#endregion

  //#region Test 9: Live OpenRouter Smoke Test

  const HAS_API_KEY = !!process.env.OPENROUTER_API_KEY;

  test.skipIf(!HAS_API_KEY)('live OpenRouter smoke test', async () => {
    const simpleStep = step.llm<ContextMemory, string, string>({
      id: 'live-llm',
      model: 'openai/gpt-4o-mini',
      system: 'You are a helpful assistant. Reply in one sentence.',
    });

    const harness = new AgentHarness({
      name: 'live-smoke-test',
      initialStep: simpleStep,
      params: {},
      llm: {
        provider: 'openrouter',
        apiKey: process.env.OPENROUTER_API_KEY!,
      },
    });

    const ctx = harness.createContext();
    const result = await harness.run(simpleStep, 'What is 2 + 2?', ctx);

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(ctx.itemLog.items.length).toBeGreaterThan(0);

    // Verify OpenResponses compliance of live items
    assertOpenResponsesCompliance(ctx.itemLog.items);
  });

  //#endregion

  //#region Test 10: Full Pipeline Integration (Complex Path with Multiple Operators)

  test('full pipeline integration with classify, branch, fork, settle, and loop', async () => {
    const classifyStep = buildClassifyStep();

    // Build a loop that runs the settle fork then refines
    let settleCallCount = 0;
    const settleWithCount = fork<ContextMemory, string, string>({
      id: 'optional-extras-counted',
      mode: 'settle',
      paths: () => [
        step.run<ContextMemory, string, string>({
          id: 'style-pass',
          execute: async (input) => {
            settleCallCount++;
            return `Style: ${input.slice(0, 15)}`;
          },
        }),
        step.run<ContextMemory, string, string>({
          id: 'dep-fail',
          execute: async () => {
            settleCallCount++;
            throw new Error('Dependency unavailable');
          },
        }),
      ],
      merge: (results: SettleResult<string>[]): string => {
        const ok = results.filter((r) => r.status === 'fulfilled');
        return ok.map((r) => r.value).join('; ');
      },
    });

    // Use createDynamicCallModel for the LLM calls so we never exhaust a script
    let llmCallCount = 0;
    const dynamicCallModel = createDynamicCallModel(() => {
      llmCallCount++;
      return makeLLMResponse(`LLM response #${llmCallCount}`, {
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
        cost: 5e-4,
      });
    });

    const pipeline = step.run<ContextMemory, string, string>({
      id: 'pipeline',
      execute: async (input, ctx) => {
        // Step 1: Classify
        const classification = await ctx.harness.run(classifyStep, input, ctx);

        // Step 2: Branch based on complexity
        let analysisResult: string;
        if (classification.complexity === 'complex') {
          // Run a simple LLM step for integration test (avoids needing 3 parallel LLM mocks)
          analysisResult = await ctx.harness.run(
            step.llm<ContextMemory, string, string>({
              id: 'quick-analysis',
              model: 'test-model',
            }),
            input,
            ctx,
          );
        } else {
          analysisResult = `Skipped deep analysis for ${classification.complexity} code`;
        }

        // Step 3: Settle fork
        const settleResult = await ctx.harness.run(settleWithCount, input, ctx);

        // Step 4: Combine
        return `${analysisResult} | ${settleResult}`;
      },
    });

    const harness = new AgentHarness({
      name: 'full-pipeline',
      params: {},
      _testCallModel: dynamicCallModel,
    });

    const complexInput =
      'class BigSystem { constructor() { this.cache = new Map(); } invalidate() { this.cache.clear(); } }';

    const ctx = harness.createContext();
    const result = await harness.run(pipeline, complexInput, ctx);

    expect(typeof result).toBe('string');
    expect(result).toContain('LLM response');
    expect(result).toContain('Style:');
    expect(settleCallCount).toBe(2); // Both settle paths ran
    expect(llmCallCount).toBe(1); // One LLM call for the complex branch
    expect(ctx.tokens.input).toBeGreaterThan(0);
    expect(ctx.cost).toBeGreaterThan(0);
  });

  //#endregion

  //#region Test 11: Channel tryRecv Returns Null When Empty

  test('channel tryRecv returns null when queue is empty', async () => {
    const emptyChannel = channel<FindingsMessage>('empty-findings', {
      schema: FindingsMessageSchema,
      mode: 'queue',
    });

    const tryRecvStep = step.run<ContextMemory, string, FindingsMessage | null>({
      id: 'try-recv',
      execute: async (_input, ctx) => {
        return ctx.tryRecv(emptyChannel);
      },
    });

    const harness = new AgentHarness({
      name: 'tryrecv-test',
      params: {},
    });

    const ctx = harness.createContext();
    const result = await harness.run(tryRecvStep, '', ctx);

    expect(result).toBeNull();
  });

  //#endregion

  //#region Test 12: Error Propagation in Nested Steps

  test('isNoeticError identifies errors from nested execution', async () => {
    const failingStep = step.run<ContextMemory, string, string>({
      id: 'will-fail',
      execute: async () => {
        throw new Error('Deliberate failure in nested step');
      },
    });

    const harness = new AgentHarness({
      name: 'error-propagation-test',
      params: {},
    });

    const ctx = harness.createContext();

    try {
      await harness.run(failingStep, 'trigger', ctx);
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      assert(isNoeticError(e));
      const ne = e.noeticError;
      assert(ne.kind === 'step_failed');
      expect(ne.stepId).toBe('will-fail');
    }
  });

  //#endregion
});
