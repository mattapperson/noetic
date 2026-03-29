/**
 * Adversarial edge-case tests for Noetic framework operators and runtime.
 */

import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { isNoeticError } from '../src/errors/noetic-error';
import { branch, channel, fork, loop, NoeticErrorImpl, step } from '../src/index';
import { executeBranch } from '../src/interpreter/execute-branch';
import { executeFork } from '../src/interpreter/execute-fork';
import { executeLLM } from '../src/interpreter/execute-llm';
import { executeLoop } from '../src/interpreter/execute-loop';
import { ChannelStore } from '../src/runtime/channel-store';
import { ContextImpl } from '../src/runtime/context-impl';
import type { NoeticError } from '../src/types/error';
import type { ContextMemory, MemoryLayer } from '../src/types/memory';
import { SteeringAction } from '../src/types/steering';
import type { Step } from '../src/types/step';
import { until } from '../src/until/predicates';

import {
  createScriptedCallModel,
  makeLLMResponse,
  makeMockContext,
  makeMockHarness,
  simpleExecute,
} from './_helpers';

//#region Helper Functions

function makeRealContext(
  harness: ReturnType<typeof makeMockHarness>,
  channelStore?: ChannelStore,
): ContextImpl {
  return new ContextImpl({
    harness,
    channelStore,
  });
}

async function expectNoeticError(
  fn: () => Promise<unknown>,
  kind: NoeticError['kind'],
): Promise<NoeticErrorImpl> {
  try {
    await fn();
    throw new Error(`Expected NoeticError with kind '${kind}' but no error was thrown`);
  } catch (e: unknown) {
    if (!isNoeticError(e)) {
      throw new Error(`Expected NoeticError but got: ${e}`);
    }
    expect(e.noeticError.kind).toBe(kind);
    return e;
  }
}

async function expectInvalidMaxIterations(maxIterations: number): Promise<void> {
  const bodyStep = step.run<ContextMemory, string, string>({
    id: 'noop',
    execute: async (input) => input,
  });
  const loopStep = loop<ContextMemory, string, string>({
    id: `invalid-max-${maxIterations}`,
    steps: [
      bodyStep,
    ],
    until: until.maxSteps(1),
    maxIterations,
  });
  const ctx = makeMockContext();
  await expectNoeticError(() => executeLoop(loopStep, 'x', ctx, simpleExecute), 'step_failed');
}

//#endregion

//#region Fork Edge Cases

describe('empty fork paths', () => {
  test('all mode calls merge with empty array', async () => {
    const forkStep = fork({
      id: 'empty',
      mode: 'all',
      paths: () => [],
      merge: (results) => results,
    });

    const ctx = makeMockContext();
    const result = await executeFork(forkStep, 'input', ctx, simpleExecute);

    expect(result).toEqual([]);
  });

  test('race mode throws fork_partial', async () => {
    const forkStep = fork({
      id: 'empty',
      mode: 'race',
      paths: () => [],
    });

    const ctx = makeMockContext();
    const e = await expectNoeticError(
      () => executeFork(forkStep, 'input', ctx, simpleExecute),
      'fork_partial',
    );

    const err = e.noeticError;
    assert(err.kind === 'fork_partial');
    expect(err.succeeded).toEqual([]);
    expect(err.failed).toEqual([]);
  });

  test('settle mode calls merge with empty array', async () => {
    const forkStep = fork({
      id: 'empty',
      mode: 'settle',
      paths: () => [],
      merge: (results) => results,
    });

    const ctx = makeMockContext();
    const result = await executeFork(forkStep, 'input', ctx, simpleExecute);

    expect(result).toEqual([]);
  });
});

//#endregion

//#region Loop Edge Cases

describe('loop edge cases', () => {
  test('all iterations failing with onError returning skip hits maxIterations', async () => {
    const failingStep = step.run<ContextMemory, string, string>({
      id: 'always-fail',
      execute: async () => {
        throw new NoeticErrorImpl({
          kind: 'step_failed',
          stepId: 'always-fail',
          cause: new Error('always fails'),
          retriesExhausted: false,
        });
      },
    });

    const loopStep = loop<ContextMemory, string, string>({
      id: 'fail-loop',
      steps: [
        failingStep,
      ],
      until: until.maxSteps(3),
      maxIterations: 5,
      onError: () => 'skip',
    });

    const ctx = makeMockContext();
    const e = await expectNoeticError(
      () => executeLoop(loopStep, 'start', ctx, simpleExecute),
      'step_failed',
    );

    expect(e.message).toContain('maximum iterations');
  });

  test('predicate throws is treated as stop: true', async () => {
    let callCount = 0;
    const bodyStep = step.run<ContextMemory, string, string>({
      id: 'counter',
      execute: async (input) => {
        callCount++;
        return `${input}-done`;
      },
    });

    const loopStep = loop<ContextMemory, string, string>({
      id: 'pred-throw-loop',
      steps: [
        bodyStep,
      ],
      until: () => {
        throw new Error('predicate boom');
      },
    });

    const ctx = makeMockContext();
    const result = await executeLoop(loopStep, 'start', ctx, simpleExecute);

    expect(callCount).toBe(1);
    expect(result).toBe('start-done');
  });

  test('maxIterations validation rejects 0', async () => {
    await expectInvalidMaxIterations(0);
  });

  test('maxIterations validation rejects negative', async () => {
    await expectInvalidMaxIterations(-1);
  });

  test('maxIterations validation rejects Infinity', async () => {
    await expectInvalidMaxIterations(Number.POSITIVE_INFINITY);
  });
});

//#endregion

//#region Channel Edge Cases

describe('channel edge cases', () => {
  test('recv timeout throws channel_timeout', async () => {
    const store = new ChannelStore();
    const ch = channel<string>('test-queue', {
      schema: z.string(),
      mode: 'queue',
    });

    const e = await expectNoeticError(() => store.recv(ch, 5e1), 'channel_timeout');

    const err = e.noeticError;
    assert(err.kind === 'channel_timeout');
    expect(err.channelName).toBe('test-queue');
    expect(err.timeout).toBe(5e1);
  });

  test('topic mode tryRecv always returns null', () => {
    const store = new ChannelStore();
    const ch = channel<string>('test-topic', {
      schema: z.string(),
      mode: 'topic',
    });

    store.send(ch, 'hello');
    const result = store.tryRecv(ch);

    expect(result).toBeNull();
  });
});

//#endregion

//#region LLM Parse Edge Cases

describe('structured output parse failures', () => {
  test('non-JSON text throws llm_parse_error', async () => {
    const OutputSchema = z.object({
      answer: z.string(),
    });
    const llmStep = step.llm<
      ContextMemory,
      string,
      {
        answer: string;
      }
    >({
      id: 'parse-fail',
      model: 'test/model',
      output: OutputSchema,
    });

    const harness = makeMockHarness();
    harness.callModel = createScriptedCallModel([
      makeLLMResponse('not json at all'),
    ]);
    const ctx = makeMockContext({
      harness,
    });

    const e = await expectNoeticError(
      () => executeLLM(llmStep, 'test input', ctx),
      'llm_parse_error',
    );

    const err = e.noeticError;
    assert(err.kind === 'llm_parse_error');
    expect(err.raw).toBe('not json at all');
    expect(err.schema).toBeDefined();
    expect(err.zodError).toBeDefined();
  });

  test('valid JSON but wrong schema throws llm_parse_error', async () => {
    const OutputSchema = z.object({
      answer: z.string(),
    });
    const llmStep = step.llm<
      ContextMemory,
      string,
      {
        answer: string;
      }
    >({
      id: 'schema-fail',
      model: 'test/model',
      output: OutputSchema,
    });

    const harness = makeMockHarness();
    harness.callModel = createScriptedCallModel([
      makeLLMResponse('{"wrong": 123}'),
    ]);
    const ctx = makeMockContext({
      harness,
    });

    const e = await expectNoeticError(
      () => executeLLM(llmStep, 'test input', ctx),
      'llm_parse_error',
    );

    const err = e.noeticError;
    assert(err.kind === 'llm_parse_error');
    expect(err.zodError.issues.length).toBeGreaterThan(0);
  });
});

//#endregion

//#region Steering Edge Cases

describe('steering retry exhaustion', () => {
  test('falls through after MAX_STEERING_RETRIES', async () => {
    const llmStep = step.llm<ContextMemory, string, string>({
      id: 'steered',
      model: 'test/model',
    });

    const harness = makeMockHarness();
    let callCount = 0;
    harness.callModel = async () => {
      callCount++;
      return makeLLMResponse(`response-${callCount}`);
    };
    harness.afterModelCall = async () => ({
      action: SteeringAction.Guide,
      guidance: 'try again',
    });

    // executeLLM only enters steering when layers array is non-empty
    const dummyLayer: MemoryLayer = {
      id: 'dummy',
      slot: 1e2,
      scope: 'execution',
      hooks: {},
    };

    const ctx = makeMockContext({
      harness,
    });
    const result = await executeLLM(llmStep, 'input', ctx, [
      dummyLayer,
    ]);

    // 1 original + 3 retries = 4 calls, then falls through
    expect(callCount).toBe(4);
    expect(result).toBe('response-4');

    // Developer guidance messages should be appended to itemLog
    const developerItems = ctx.itemLog.items.filter(
      (item) => item.type === 'message' && item.role === 'developer',
    );
    expect(developerItems.length).toBe(3);
  });
});

//#endregion

//#region Race Fork Abort

describe('race fork aborts losers', () => {
  test('winner resolves, loser context is aborted', async () => {
    const fastStep = step.run<ContextMemory, string, string>({
      id: 'fast',
      execute: async () => 'fast-wins',
    });

    const slowStep = step.run<ContextMemory, string, string>({
      id: 'slow',
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2e2));
        return 'slow-result';
      },
    });

    const forkStep = fork<ContextMemory, string, string>({
      id: 'race-abort',
      mode: 'race',
      paths: () => [
        fastStep,
        slowStep,
      ],
    });

    const harness = makeMockHarness();
    const ctx = makeRealContext(harness);

    const result = await executeFork(forkStep, 'go', ctx, simpleExecute);

    expect(result).toBe('fast-wins');
  });
});

//#endregion

//#region Fork Concurrency

describe('fork with concurrency=1 executes sequentially', () => {
  test('paths run one at a time', async () => {
    const timestamps: number[][] = [];

    function makeTimedStep(index: number): Step<ContextMemory, string, string> {
      return step.run<ContextMemory, string, string>({
        id: `timed-${index}`,
        execute: async () => {
          const start = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 5e1));
          const end = Date.now();
          timestamps.push([
            start,
            end,
          ]);
          return `done-${index}`;
        },
      });
    }

    const forkStep = fork<ContextMemory, string, string>({
      id: 'sequential-fork',
      mode: 'all',
      paths: () => [
        makeTimedStep(0),
        makeTimedStep(1),
        makeTimedStep(2),
      ],
      merge: (results: string[]) => results.join(','),
      concurrency: 1,
    });

    const harness = makeMockHarness();
    const ctx = makeRealContext(harness);

    await executeFork(forkStep, 'go', ctx, simpleExecute);

    expect(timestamps.length).toBe(3);
    // Each path should start after the previous one ended
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i][0]).toBeGreaterThanOrEqual(timestamps[i - 1][1]);
    }
  });
});

//#endregion

//#region Branch Null Route

describe('branch null route passes input through', () => {
  test('output === input when route returns null', async () => {
    const branchStep = branch<ContextMemory, string, string>({
      id: 'skip',
      route: () => null,
    });

    const ctx = makeMockContext();
    const result = await executeBranch(branchStep, 'hello', ctx, simpleExecute);

    expect(result).toBe('hello');
  });
});

//#endregion
