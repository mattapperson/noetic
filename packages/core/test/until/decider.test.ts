// A decide step used as a loop's `until`: one boolean question, yes stops the
// loop, no or a refusal runs another iteration. These tests run real loops
// through a harness whose decision model is the `_testDecide` stub.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  BooleanAnswer,
  ContextData,
  DecideRequest,
  DecideResponse,
  Refusal,
  Snapshot,
  UntilRun,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { decide } from '../../src/builders/decide-builders';
import { loop } from '../../src/builders/loop-builder';
import { runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { isMutableContext } from '../../src/interpreter/typeguards';
import { all, any } from '../../src/until/combinators';
import { toUntil } from '../../src/until/decider';
import { until } from '../../src/until/predicates';

//#region Helpers

const STOP_QUESTION = {
  stop: {
    type: 'boolean',
    instructions: 'Is the work finished?',
  },
} as const;

function isDone(id = 'done') {
  return decide({
    id,
    model: 'typesafe/jev-1.14',
    questions: STOP_QUESTION,
  });
}

function yes(probability = 0.9): BooleanAnswer {
  return {
    type: 'boolean',
    value: true,
    probability,
  };
}

function no(probability = 0.1): BooleanAnswer {
  return {
    type: 'boolean',
    value: false,
    probability,
  };
}

const REFUSED: Refusal = {
  type: 'refusal',
};

function response(answer: BooleanAnswer | Refusal): DecideResponse {
  return {
    answers: {
      stop: answer,
    },
    source: 'native',
    modelId: 'typesafe/jev-1.14',
    usage: {
      inputTokens: 10,
      outputTokens: 0,
    },
  };
}

/** The `input` state entry the decider sent: the loop's last output. */
function inputOf(request: DecideRequest): unknown {
  const part = request.state.find((p) => p.type !== 'image' && p.name === 'input');
  assert(part, 'decide request carries no input');
  return part.type === 'json' ? part.value : part.type === 'text' ? part.text : undefined;
}

function harnessAnswering(
  answer: (request: DecideRequest, call: number) => BooleanAnswer | Refusal,
): {
  harness: AgentHarness;
  requests: DecideRequest[];
} {
  const requests: DecideRequest[] = [];
  const harness = new AgentHarness({
    name: 'until-decider-test',
    params: {},
    _testCallModel: async () => {
      throw new Error('an until decider must not call the chat model');
    },
    _testDecide: async (request) => {
      requests.push(request);
      return response(answer(request, requests.length));
    },
  });
  return {
    harness,
    requests,
  };
}

const increment = runCode<ContextData, number, number>({
  id: 'inc',
  execute: async (n) => n + 1,
});

function snapshot(lastOutput: unknown): Snapshot {
  return {
    stepCount: 1,
    tokens: {
      input: 0,
      output: 0,
      total: 0,
    },
    elapsed: 0,
    cost: 0,
    lastOutput,
    lastText: String(lastOutput),
    history: [],
    depth: 0,
  };
}

async function expectConfigCode(fn: () => unknown, code: string): Promise<void> {
  try {
    await fn();
    expect.unreachable(`expected ${code}`);
  } catch (e) {
    assert(isNoeticConfigError(e));
    expect(e.code).toBe(code);
  }
}

//#endregion

//#region Tests

describe('loop until a decide step', () => {
  it('asks about each iteration output and stops on yes', async () => {
    const { harness, requests } = harnessAnswering((request) =>
      inputOf(request) === 3 ? yes() : no(),
    );
    const step = loop<ContextData, number, number>({
      id: 'count',
      steps: [
        increment,
      ],
      until: isDone(),
    });
    const ctx = harness.createContext();
    expect(await harness.run(step, 0, ctx)).toBe(3);
    expect(requests.map(inputOf)).toEqual([
      1,
      2,
      3,
    ]);
    // Decide merges its metadata into lastStepMeta (spec 32).
    assert(isMutableContext(ctx));
    expect(ctx.lastStepMeta?.decision?.refused).toEqual([]);
  });

  it('a refusal continues the loop', async () => {
    const { harness, requests } = harnessAnswering((_request, call) =>
      call < 3 ? REFUSED : yes(),
    );
    const step = loop<ContextData, number, number>({
      id: 'refusals',
      steps: [
        increment,
      ],
      until: isDone(),
    });
    expect(await harness.run(step, 0, harness.createContext())).toBe(3);
    expect(requests).toHaveLength(3);
  });

  it('asks afresh each iteration even when the output and conversation repeat', async () => {
    // The body returns the same value and logs nothing, so decide's reuse key
    // (step id, input, conversation length) is identical every iteration.
    const { harness, requests } = harnessAnswering((_request, call) => (call === 1 ? no() : yes()));
    const step = loop<ContextData, string, string>({
      id: 'same',
      steps: [
        runCode<ContextData, string, string>({
          id: 'constant',
          execute: async () => 'unchanged',
        }),
      ],
      until: isDone(),
      maxIterations: 5,
    });
    expect(await harness.run(step, 'start', harness.createContext())).toBe('unchanged');
    expect(requests).toHaveLength(2);
  });

  it('with maxIterations: Infinity, runs past the default cap until the decider says yes', async () => {
    const target = 1.2e3;
    const { harness } = harnessAnswering((request) => (inputOf(request) === target ? yes() : no()));
    const step = loop<ContextData, number, number>({
      id: 'uncapped',
      steps: [
        increment,
      ],
      until: isDone(),
      maxIterations: Number.POSITIVE_INFINITY,
      maxHistorySize: 1,
    });
    expect(await harness.run(step, 0, harness.createContext())).toBe(target);
  });

  it('cancellation during the decision propagates instead of stopping the loop', async () => {
    const harness = new AgentHarness({
      name: 'until-decider-abort',
      params: {},
      _testDecide: async () => {
        ctx.abort('stop now');
        return response(no());
      },
    });
    const ctx = harness.createContext();
    const step = loop<ContextData, number, number>({
      id: 'aborted',
      steps: [
        increment,
      ],
      until: isDone(),
    });
    try {
      await harness.run(step, 0, ctx);
      expect.unreachable('expected cancelled');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('cancelled');
    }
  });

  it('inside any(): maxSteps ends the loop when the decider keeps saying no', async () => {
    const { harness, requests } = harnessAnswering(() => no());
    const step = loop<ContextData, number, number>({
      id: 'capped',
      steps: [
        increment,
      ],
      until: any(until.maxSteps(20), isDone()),
    });
    expect(await harness.run(step, 0, harness.createContext())).toBe(20);
    // any() short-circuits, so the 20th iteration never asks.
    expect(requests).toHaveLength(19);
  });

  it('inside any(): the decider ends the loop before maxSteps', async () => {
    const { harness } = harnessAnswering((request) => (inputOf(request) === 2 ? yes() : no()));
    const step = loop<ContextData, number, number>({
      id: 'early',
      steps: [
        increment,
      ],
      until: any(until.maxSteps(20), isDone()),
    });
    expect(await harness.run(step, 0, harness.createContext())).toBe(2);
  });

  it('inside all(): stops only when the decider and the other predicate agree', async () => {
    const { harness } = harnessAnswering(() => yes());
    const step = loop<ContextData, number, number>({
      id: 'both',
      steps: [
        increment,
      ],
      until: all(isDone(), until.maxSteps(4)),
    });
    expect(await harness.run(step, 0, harness.createContext())).toBe(4);
  });
});

describe('until decider verdicts', () => {
  const run = (answer: BooleanAnswer | Refusal): UntilRun => {
    const harness = new AgentHarness({
      name: 'verdicts',
      params: {},
    });
    return {
      ctx: harness.createContext(),
      executeStep: async <_C, _I, O>(): Promise<O> =>
        frameworkCast<O>({
          stop: answer,
        }),
    };
  };

  it('a yes stops, naming the question, answer, and probability', async () => {
    expect(await toUntil(isDone('check'))(snapshot('x'), run(yes(0.82)))).toEqual({
      stop: true,
      reason: "decide 'check' answered 'stop' yes (p=0.82)",
    });
  });

  it('a no continues, naming the question, answer, and probability', async () => {
    expect(await toUntil(isDone('check'))(snapshot('x'), run(no(0.3)))).toEqual({
      stop: false,
      reason: "decide 'check' answered 'stop' no (p=0.30)",
    });
  });

  it('a refusal continues', async () => {
    expect(await toUntil(isDone('check'))(snapshot('x'), run(REFUSED))).toEqual({
      stop: false,
      reason: "decide 'check' refused 'stop'; continuing",
    });
  });

  it('a plain predicate passes through unchanged', () => {
    const pred = until.maxSteps(3);
    expect(toUntil(pred)).toBe(pred);
  });

  it('called outside a loop, a decider throws INVALID_UNTIL_DECIDER', async () => {
    await expectConfigCode(() => toUntil(isDone())(snapshot('x')), 'INVALID_UNTIL_DECIDER');
  });
});

describe('until decider validation', () => {
  const choice = () =>
    decide({
      id: 'pick',
      model: 'typesafe/jev-1.14',
      questions: {
        next: {
          type: 'choice',
          choices: [
            'stop',
            'go',
          ],
        },
      },
    });
  const twoBooleans = () =>
    decide({
      id: 'two',
      model: 'typesafe/jev-1.14',
      questions: {
        stop: {
          type: 'boolean',
          instructions: 'Done?',
        },
        again: {
          type: 'boolean',
          instructions: 'Again?',
        },
      },
    });
  const build = (decider: ReturnType<typeof choice> | ReturnType<typeof twoBooleans>) =>
    loop<ContextData, number, number>({
      id: 'bad',
      steps: [
        increment,
      ],
      until: decider,
    });

  it('loop() rejects a decider whose question is not boolean', async () => {
    await expectConfigCode(() => build(choice()), 'INVALID_UNTIL_DECIDER');
  });

  it('loop() rejects a decider with more than one question', async () => {
    await expectConfigCode(() => build(twoBooleans()), 'INVALID_UNTIL_DECIDER');
  });

  it('any() and all() reject a bad decider where they are built', async () => {
    await expectConfigCode(() => any(until.maxSteps(3), choice()), 'INVALID_UNTIL_DECIDER');
    await expectConfigCode(() => all(twoBooleans()), 'INVALID_UNTIL_DECIDER');
  });
});

//#endregion
