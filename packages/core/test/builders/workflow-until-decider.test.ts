// JSON loops: `maxIterations: "infinity"`, and a `decide` node as the `until`
// predicate (alone or inside any/all).

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { DecideRequest, DecideResponse, Step } from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError } from '@noetic-tools/types';
import { parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import type { HydrationContext } from '../../src/builders/workflow-hydrator';
import { hydrateNode } from '../../src/builders/workflow-hydrator';
import { AgentHarness } from '../../src/harness/agent-harness';
import { runToReturn } from '../../src/interpreter/emit-items';
import type { UntilPredicate, WorkflowNode } from '../../src/schemas/workflow';
import {
  WorkflowNodeSchema,
  walkWorkflow,
  workflowDepth,
  workflowGraph,
} from '../../src/schemas/workflow';
import { makeMockContext, makeTestTool } from '../_helpers';

//#region Helpers

const DECIDER = {
  kind: 'decide',
  id: 'done',
  model: 'typesafe/jev-1.14',
  questions: {
    stop: {
      type: 'boolean',
      instructions: 'Has the count reached three?',
    },
  },
} as const satisfies UntilPredicate;

function loopNode(until: UntilPredicate, maxIterations?: number | 'infinity'): WorkflowNode {
  return {
    kind: 'loop',
    id: 'work',
    body: {
      kind: 'callModel',
      id: 'step',
      instructions: 'work',
    },
    until,
    maxIterations,
  };
}

function isValid(node: unknown): boolean {
  return WorkflowNodeSchema.safeParse(node).success;
}

/** Runs `runCode` wrappers for real and records every step it is asked to run. */
function recordingContext(): {
  ctx: HydrationContext;
  ran: Step[];
} {
  const ran: Step[] = [];
  const ctx: HydrationContext = {
    tools: new Map(),
    executeStep: async (step, input, execCtx) => {
      ran.push(frameworkCast<Step>(step));
      if (step.kind === 'runCode') {
        return frameworkCast(await runToReturn(step.execute(input, execCtx), async () => {}));
      }
      return frameworkCast(input);
    },
  };
  return {
    ctx,
    ran,
  };
}

/** The ids of the decide steps used as `until` by the loops that ran. */
function deciderIds(ran: Step[]): string[] {
  return ran.flatMap((s) =>
    s.kind === 'loop' && typeof s.until !== 'function'
      ? [
          s.until.id,
        ]
      : [],
  );
}

function decideResponse(value: boolean): DecideResponse {
  return {
    answers: {
      stop: {
        type: 'boolean',
        value,
        probability: value ? 0.9 : 0.1,
      },
    },
    source: 'native',
    modelId: 'typesafe/jev-1.14',
    usage: {
      inputTokens: 10,
      outputTokens: 0,
    },
  };
}

function inputText(request: DecideRequest): string {
  const part = request.state.find((p) => p.type === 'text' && p.name === 'input');
  assert(part && part.type === 'text');
  return part.text;
}

//#endregion

//#region Tests

describe('loop maxIterations in JSON', () => {
  it('accepts a positive integer or exactly "infinity"', () => {
    expect(isValid(loopNode(DECIDER, 5))).toBe(true);
    expect(isValid(loopNode(DECIDER, 'infinity'))).toBe(true);
  });

  for (const invalid of [
    0,
    -1,
    1.5,
    Number.NaN,
    'Infinity',
    'inf',
    '1000',
  ]) {
    it(`rejects maxIterations ${JSON.stringify(invalid) ?? String(invalid)}`, () => {
      expect(
        isValid({
          ...loopNode(DECIDER),
          maxIterations: invalid,
        }),
      ).toBe(false);
    });
  }

  it('hydrates "infinity" to Number.POSITIVE_INFINITY', () => {
    const step = hydrateNode(loopNode(DECIDER, 'infinity'), recordingContext().ctx);
    assert(step.kind === 'loop');
    expect(step.maxIterations).toBe(Number.POSITIVE_INFINITY);
  });

  it('passes an integer cap through unchanged', () => {
    const step = hydrateNode(loopNode(DECIDER, 7), recordingContext().ctx);
    assert(step.kind === 'loop');
    expect(step.maxIterations).toBe(7);
  });
});

describe('decide node as an until predicate: schema', () => {
  it('accepts a one-boolean-question decide node, alone or inside any/all', () => {
    expect(isValid(loopNode(DECIDER))).toBe(true);
    expect(
      isValid(
        loopNode({
          kind: 'any',
          predicates: [
            {
              kind: 'maxSteps',
              n: 20,
            },
            DECIDER,
          ],
        }),
      ),
    ).toBe(true);
    expect(
      isValid(
        loopNode({
          kind: 'all',
          predicates: [
            DECIDER,
          ],
        }),
      ),
    ).toBe(true);
  });

  it('rejects a decider whose question is not boolean', () => {
    const result = WorkflowNodeSchema.safeParse(
      loopNode({
        ...DECIDER,
        questions: {
          next: {
            type: 'choice',
            choices: [
              'stop',
              'go',
            ],
          },
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('exactly one question');
  });

  it('rejects a decider with two questions, even inside any', () => {
    expect(
      isValid(
        loopNode({
          kind: 'any',
          predicates: [
            {
              ...DECIDER,
              questions: {
                ...DECIDER.questions,
                again: {
                  type: 'boolean',
                  instructions: 'Again?',
                },
              },
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe('decide node as an until predicate: walk and graph', () => {
  const node = loopNode({
    kind: 'any',
    predicates: [
      {
        kind: 'maxSteps',
        n: 3,
      },
      DECIDER,
    ],
  });

  it('walkWorkflow and workflowGraph see the decider as a child of its loop', () => {
    expect(
      [
        ...walkWorkflow(node),
      ].map((n) => n.id),
    ).toEqual([
      'work',
      'step',
      'done',
    ]);
    expect(workflowGraph(node).edges).toContainEqual({
      from: 'work',
      to: 'done',
    });
  });

  it('a decider adds no depth beyond the loop', () => {
    expect(workflowDepth(node)).toBe(1);
  });
});

describe('decide node as an until predicate: hydration', () => {
  it('hydrates a lone decider into the loop step itself', () => {
    const step = hydrateNode(loopNode(DECIDER), recordingContext().ctx);
    assert(step.kind === 'loop');
    assert(typeof step.until !== 'function');
    expect(step.until.kind).toBe('decide');
    expect(step.until.id).toBe('done');
  });

  it('a subflow suffixes the decider id with its own', async () => {
    const { ctx, ran } = recordingContext();
    const wrapper = hydrateNode(
      {
        kind: 'subflow',
        id: 'sub',
        document: {
          version: 1,
          root: loopNode(DECIDER),
        },
      },
      ctx,
    );
    assert(wrapper.kind === 'runCode');
    await wrapper.execute('in', makeMockContext());
    expect(deciderIds(ran)).toEqual([
      'done-sub',
    ]);
  });

  it('a dynamic each suffixes the decider id with the item index', async () => {
    const { ctx, ran } = recordingContext();
    const fan = hydrateNode(
      {
        kind: 'inParallel',
        id: 'fan',
        mode: 'all',
        each: loopNode(DECIDER),
      },
      ctx,
    );
    assert(fan.kind === 'inParallel');
    const execCtx = makeMockContext();
    for (const path of fan.paths('["a","b"]', execCtx)) {
      assert(path.kind === 'runCode');
      await path.execute('', execCtx);
    }
    expect(deciderIds(ran)).toEqual([
      'done-0',
      'done-1',
    ]);
  });
});

describe('decide node as an until predicate: end to end', () => {
  async function runCounter(until: UntilPredicate, stopAt: number) {
    const requests: DecideRequest[] = [];
    const harness = new AgentHarness({
      name: 'json-until-decider',
      params: {},
      _testDecide: async (request) => {
        requests.push(request);
        return decideResponse(inputText(request).includes(`"${stopAt}"`));
      },
    });
    let count = 0;
    const tick = makeTestTool({
      name: 'tick',
      execute: async () => ({
        result: String(++count),
      }),
    });
    const output = await parseAndRunWorkflow({
      json: {
        version: 1,
        root: {
          kind: 'loop',
          id: 'count',
          body: {
            kind: 'invokeTool',
            id: 'tick-step',
            toolName: 'tick',
            args: {
              query: 'next',
            },
          },
          until,
          maxIterations: 'infinity',
        },
      },
      harness,
      ctx: harness.createContext(),
      tools: [
        tick,
      ],
      input: 'go',
    });
    return {
      output,
      requests,
      count,
    };
  }

  it('an uncapped JSON loop ends when its decide node answers yes', async () => {
    const { output, requests, count } = await runCounter(DECIDER, 3);
    expect(output).toBe('{"result":"3"}');
    expect(count).toBe(3);
    expect(requests).toHaveLength(3);
  });

  it('inside any, maxSteps ends the loop when the decider never says yes', async () => {
    const { count } = await runCounter(
      {
        kind: 'any',
        predicates: [
          {
            kind: 'maxSteps',
            n: 4,
          },
          DECIDER,
        ],
      },
      99,
    );
    expect(count).toBe(4);
  });

  it('parseAndRunWorkflow rejects a non-boolean decider before running', async () => {
    const harness = new AgentHarness({
      name: 'json-until-decider-invalid',
      params: {},
    });
    try {
      await parseAndRunWorkflow({
        json: {
          version: 1,
          root: loopNode({
            ...DECIDER,
            questions: {
              level: {
                type: 'score',
                levels: [
                  'low',
                  'high',
                ],
              },
            },
          }),
        },
        harness,
        ctx: harness.createContext(),
        tools: [],
        input: 'go',
      });
      expect.unreachable('expected WORKFLOW_VALIDATION_FAILED');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('WORKFLOW_VALIDATION_FAILED');
      expect(e.message).toContain('exactly one question');
    }
  });
});

//#endregion
