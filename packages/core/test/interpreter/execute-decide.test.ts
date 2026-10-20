import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextLayer } from '@noetic-tools/context';
import { decisionsHistoryLayer, steering } from '@noetic-tools/context';
import type {
  DecideRequest,
  DecideResponse,
  DecisionRecord,
  NoeticError,
  StreamEvent,
} from '@noetic-tools/types';
import {
  createMessage,
  DecideOutputError,
  frameworkCast,
  isNoeticConfigError,
  isNoeticError,
} from '@noetic-tools/types';
import { z } from 'zod';
import { fork } from '../../src/builders/control-flow-builders';
import { step } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { execute } from '../../src/interpreter/execute';
import { isMutableContext } from '../../src/interpreter/typeguards';
import { EventBroadcaster } from '../../src/runtime/event-broadcaster';

//#region Helpers

const QUESTIONS = {
  destination: {
    type: 'choice',
    instructions: 'Which team?',
    choices: {
      billing: 'Refunds',
      sales: 'Pricing',
    },
  },
  isUrgent: {
    type: 'boolean',
    instructions: 'Is it urgent?',
  },
} as const;

function answered(overrides?: Partial<DecideResponse>): DecideResponse {
  return {
    answers: {
      destination: {
        type: 'choice',
        value: 'billing',
        confidence: 0.7,
        probabilities: {
          billing: 0.8,
          sales: 0.2,
        },
      },
      isUrgent: {
        type: 'boolean',
        value: true,
        probability: 0.9,
      },
    },
    source: 'native',
    modelId: 'typesafe/jev-1.14',
    usage: {
      inputTokens: 40,
      outputTokens: 5,
    },
    cost: 0.001,
    ...overrides,
  };
}

function harnessWith(opts: {
  respond?: (request: DecideRequest) => Promise<DecideResponse>;
  context?: ContextLayer[];
  decisionModel?: string;
}): {
  harness: AgentHarness;
  requests: DecideRequest[];
} {
  const requests: DecideRequest[] = [];
  const harness = new AgentHarness({
    name: 'decide-test',
    params: {},
    context: opts.context,
    decisionModel: opts.decisionModel,
    _testCallModel: async () => {
      throw new Error('decide must not call the chat model');
    },
    _testDecide: async (request) => {
      requests.push(request);
      return opts.respond ? opts.respond(request) : answered();
    },
  });
  return {
    harness,
    requests,
  };
}

/** A layer whose recall drains a queue — the shape of the steering layer. */
function drainingLayer(): ContextLayer<{
  queue: string[];
}> {
  return {
    id: 'drain',
    slot: 90,
    scope: 'execution',
    hooks: {
      async init() {
        return {
          state: {
            queue: [
              'queued guidance',
            ],
          },
        };
      },
      async recall({ state }) {
        if (state.queue.length === 0) {
          return null;
        }
        return {
          items: [
            createMessage(state.queue.join('\n'), 'developer'),
          ],
          tokenCount: 4,
          state: {
            queue: [],
          },
        };
      },
    },
  };
}

//#endregion

describe('executeDecide', () => {
  it('returns typed answers and records usage and decision metadata without touching the item log', async () => {
    const { harness } = harnessWith({});
    const ctx = harness.createContext();
    const triage = step.decide({
      id: 'triage',
      model: 'typesafe/jev-1.14',
      questions: QUESTIONS,
    });

    const answers = await harness.run(triage, 'refund please', ctx);

    assert(answers.destination.type === 'choice');
    expect(answers.destination.value).toBe('billing');
    assert(answers.isUrgent.type === 'boolean');
    expect(answers.isUrgent.value).toBe(true);
    expect(ctx.itemLog.items).toHaveLength(0);
    expect(ctx.tokens.input).toBe(40);
    expect(ctx.tokens.output).toBe(5);
    expect(ctx.cost).toBeCloseTo(0.001);
    expect(ctx.lastStepMeta?.decision).toEqual({
      modelId: 'typesafe/jev-1.14',
      source: 'native',
      refused: [],
    });
  });

  it('sends the input, instructions, and context selector — under one `context` entry — as state', async () => {
    const { harness, requests } = harnessWith({});
    const ctx = harness.createContext();
    await harness.run(
      step.decide({
        id: 'triage',
        model: 'typesafe/jev-1.14',
        instructions: 'Ticket triage.',
        view: 'none',
        context: () => ({
          plan: 'pro',
        }),
        questions: QUESTIONS,
      }),
      'refund please',
      ctx,
    );

    const request = requests[0];
    assert(request);
    expect(request.instructions).toBe('Ticket triage.');
    expect(request.state).toEqual([
      {
        type: 'text',
        name: 'input',
        text: 'refund please',
      },
      {
        type: 'json',
        name: 'context',
        value: {
          plan: 'pro',
        },
      },
    ]);
  });

  it('sends a non-string input as JSON state', async () => {
    const { harness, requests } = harnessWith({});
    const ctx = harness.createContext();
    const decideOnObject = step.decide({
      id: 'triage',
      model: 'm/x',
      view: 'none',
      questions: QUESTIONS,
    });
    await harness.run(
      decideOnObject,
      {
        id: 7,
      },
      ctx,
    );
    expect(requests[0]?.state[0]).toEqual({
      type: 'json',
      name: 'input',
      value: {
        id: 7,
      },
    });
  });

  it("view 'full' includes history; 'layers' and 'none' leave it out", async () => {
    const seen: Record<string, DecideRequest['state']> = {};
    for (const view of [
      'full',
      'layers',
      'none',
    ] as const) {
      const { harness, requests } = harnessWith({});
      const ctx = harness.createContext();
      ctx.itemLog.append(createMessage('my invoice is wrong', 'user'));
      await harness.run(
        step.decide({
          id: `triage-${view}`,
          model: 'm/x',
          view,
          questions: QUESTIONS,
        }),
        '',
        ctx,
      );
      seen[view] = requests[0]?.state ?? [];
    }
    expect(seen.full).toEqual([
      {
        type: 'text',
        text: 'user: my invoice is wrong',
      },
    ]);
    expect(seen.layers).toEqual([]);
    expect(seen.none).toEqual([]);
  });

  it('peeks at layer recall, so a draining layer still has its state for the next model call', async () => {
    const layer = drainingLayer();
    const { harness, requests } = harnessWith({
      context: [
        layer,
      ],
    });
    const ctx = harness.createContext();
    const decideTwice = step.decide({
      id: 'triage',
      model: 'm/x',
      view: 'layers',
      questions: QUESTIONS,
    });
    await harness.run(decideTwice, '', ctx);
    await harness.run(decideTwice, '', ctx);

    for (const request of requests) {
      expect(request.state).toEqual([
        {
          type: 'text',
          text: 'developer: queued guidance',
        },
      ]);
    }
    expect(
      harness.getLayerState<{
        queue: string[];
      }>(ctx.id, 'drain')?.queue,
    ).toEqual([
      'queued guidance',
    ]);
  });

  it('falls back to the harness decisionModel', async () => {
    const { harness, requests } = harnessWith({
      decisionModel: 'typesafe/jev-latest',
    });
    await harness.run(
      step.decide({
        id: 'triage',
        questions: QUESTIONS,
      }),
      'x',
      harness.createContext(),
    );
    expect(requests[0]?.model).toBe('typesafe/jev-latest');
  });

  it('throws MISSING_MODEL when neither the step nor the harness names a model', async () => {
    const { harness } = harnessWith({});
    try {
      await harness.run(
        step.decide({
          id: 'triage',
          questions: QUESTIONS,
        }),
        'x',
        harness.createContext(),
      );
      expect.unreachable();
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('MISSING_MODEL');
    }
  });

  it('throws llm_parse_error when an answer names an unknown choice', async () => {
    const { harness } = harnessWith({
      respond: async () => {
        const response = answered();
        return {
          ...response,
          answers: {
            ...response.answers,
            destination: {
              type: 'choice',
              value: 'support',
              confidence: 0.9,
              probabilities: {
                support: 1,
              },
            },
          },
        };
      },
    });
    try {
      await harness.run(
        step.decide({
          id: 'triage',
          model: 'm/x',
          questions: QUESTIONS,
        }),
        'x',
        harness.createContext(),
      );
      expect.unreachable();
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('llm_parse_error');
    }
  });

  it('throws llm_parse_error when a question goes unanswered', async () => {
    const { harness } = harnessWith({
      respond: async () =>
        answered({
          answers: {
            isUrgent: {
              type: 'boolean',
              value: true,
              probability: 0.9,
            },
          },
        }),
    });
    try {
      await harness.run(
        step.decide({
          id: 'triage',
          model: 'm/x',
          questions: QUESTIONS,
        }),
        'x',
        harness.createContext(),
      );
      expect.unreachable();
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('llm_parse_error');
    }
  });

  it('maps a provider 429 to llm_rate_limit and other provider errors to step_failed', async () => {
    const cases: Array<
      [
        Error,
        NoeticError['kind'],
      ]
    > = [
      [
        Object.assign(new Error('slow down'), {
          statusCode: 429,
        }),
        'llm_rate_limit',
      ],
      [
        Object.assign(new Error('text-only model got an image'), {
          statusCode: 400,
        }),
        'step_failed',
      ],
    ];
    for (const [error, kind] of cases) {
      const { harness } = harnessWith({
        respond: async () => {
          throw error;
        },
      });
      try {
        await harness.run(
          step.decide({
            id: 'triage',
            model: 'm/x',
            questions: QUESTIONS,
          }),
          'x',
          harness.createContext(),
        );
        expect.unreachable();
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe(kind);
      }
    }
  });

  it('records refusals in the decision metadata', async () => {
    const { harness } = harnessWith({
      respond: async () => {
        const response = answered();
        return {
          ...response,
          answers: {
            ...response.answers,
            isUrgent: {
              type: 'refusal',
            },
          },
        };
      },
    });
    const ctx = harness.createContext();
    const answers = await harness.run(
      step.decide({
        id: 'triage',
        model: 'm/x',
        questions: QUESTIONS,
      }),
      'x',
      ctx,
    );
    expect(answers.isUrgent.type).toBe('refusal');
    expect(ctx.lastStepMeta?.decision?.refused).toEqual([
      'isUrgent',
    ]);
  });

  it('notifies layers, so decisionsHistoryLayer exposes the decision through ctx.context', async () => {
    const { harness } = harnessWith({
      context: [
        decisionsHistoryLayer(),
      ],
    });
    const ctx = harness.createContext();
    await harness.run(
      step.decide({
        id: 'triage',
        model: 'm/x',
        questions: QUESTIONS,
      }),
      'x',
      ctx,
    );
    const read = await harness.run(
      step.run({
        id: 'read-history',
        execute: async (_input: string, c) => {
          const history = c.context.decisionsHistory;
          assert(history);
          return history.latest;
        },
      }),
      'x',
      ctx,
    );
    const record = frameworkRecord(read).triage;
    assert(record);
    expect(record.stepId).toBe('triage');
    expect(record.source).toBe('native');
  });
});

describe('executeDecide — review fixes', () => {
  it('merges into lastStepMeta, keeping the tool calls a loop reads', async () => {
    const { harness } = harnessWith({});
    const ctx = harness.createContext();
    const toolCalls = [
      {
        type: 'function_call',
        id: 'fc-1',
        callId: 'c-1',
        name: 'search',
        arguments: '{}',
        status: 'completed',
      },
    ] as const;
    await harness.run(
      step.run({
        id: 'pretend-llm',
        execute: async (_i: string, c) => {
          assert(isMutableContext(c));
          c.lastStepMeta = {
            toolCalls: frameworkCast(toolCalls),
          };
          return 'x';
        },
      }),
      'x',
      ctx,
    );
    await harness.run(
      step.decide({
        id: 'triage',
        model: 'm/x',
        questions: QUESTIONS,
      }),
      'x',
      ctx,
    );
    expect(ctx.lastStepMeta?.toolCalls).toHaveLength(1);
    expect(ctx.lastStepMeta?.decision?.source).toBe('native');
  });

  it('counts the usage of a failed estimate and still ends its span', async () => {
    const spans: string[] = [];
    const harness = new AgentHarness({
      name: 'decide-fail',
      params: {},
      traceExporter: {
        export: async (exported) => {
          spans.push(...exported.map((sp) => sp.spanId));
        },
      },
      _testCallModel: async () => {
        throw new Error('unused');
      },
      _testDecide: async () => {
        const parsed = z.object({}).strict().safeParse({
          extra: 1,
        });
        assert(!parsed.success);
        throw new DecideOutputError({
          raw: 'nope',
          schema: z.object({}),
          zodError: parsed.error,
          usage: {
            inputTokens: 30,
            outputTokens: 4,
          },
          cost: 0.002,
        });
      },
    });
    const ctx = harness.createContext();
    try {
      await harness.run(
        step.decide({
          id: 'triage',
          model: 'openai/gpt-4o-mini',
          questions: QUESTIONS,
        }),
        'x',
        ctx,
      );
      expect.unreachable();
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('llm_parse_error');
    }
    expect(ctx.tokens.input).toBe(30);
    expect(ctx.cost).toBeCloseTo(0.002);
    expect(spans).toHaveLength(1);
  });

  it('reuses answers for the same input until the conversation grows', async () => {
    const { harness, requests } = harnessWith({});
    const ctx = harness.createContext();
    const triage = step.decide({
      id: 'triage',
      model: 'm/x',
      questions: QUESTIONS,
    });
    await harness.run(triage, 'same', ctx);
    await harness.run(triage, 'same', ctx);
    expect(requests).toHaveLength(1);
    await harness.run(triage, 'different', ctx);
    expect(requests).toHaveLength(2);
    ctx.itemLog.append(createMessage('something new', 'user'));
    await harness.run(triage, 'same', ctx);
    expect(requests).toHaveLength(3);
  });

  it("leaves the real steering layer's queued guidance for the next model call", async () => {
    const { harness, requests } = harnessWith({
      context: [
        steering({
          rules: [],
        }),
      ],
    });
    const ctx = harness.createContext();
    await harness.run(
      step.run({
        id: 'init-layers',
        execute: async (i: string) => i,
      }),
      'x',
      ctx,
    );
    const state = harness.getLayerState<{
      pendingAsync: Array<{
        ruleId: string;
        guidance: string;
      }>;
    }>(ctx.id, 'steering');
    assert(state);
    state.pendingAsync.push({
      ruleId: 'r',
      guidance: 'be careful',
    });
    await harness.run(
      step.decide({
        id: 'triage',
        model: 'm/x',
        questions: QUESTIONS,
      }),
      'x',
      ctx,
    );
    expect(JSON.stringify(requests[0]?.state)).toContain('be careful');
    expect(
      harness.getLayerState<{
        pendingAsync: unknown[];
      }>(ctx.id, 'steering')?.pendingAsync,
    ).toHaveLength(1);
  });

  it('brings decisions made in fork paths back to the parent history', async () => {
    const { harness } = harnessWith({
      context: [
        decisionsHistoryLayer(),
      ],
    });
    const ctx = harness.createContext();
    const decideIn = (id: string) =>
      step.decide({
        id,
        model: 'm/x',
        questions: QUESTIONS,
      });
    await harness.run(
      fork({
        id: 'both',
        mode: 'all',
        paths: () => [
          decideIn('left'),
          decideIn('right'),
        ],
        merge: (results) => results[0],
      }),
      'x',
      ctx,
    );
    const ids = await harness.run(
      step.run({
        id: 'read',
        execute: async (_i: string, c) =>
          frameworkCast<DecisionRecord[]>(c.context.decisionsHistory?.all ?? [])
            .map((r) => r.stepId)
            .sort(),
      }),
      'x',
      ctx,
    );
    expect(ids).toEqual([
      'left',
      'right',
    ]);
  });

  it('honours emit: false, and emits step events by default', async () => {
    const eventsFor = async (emit: boolean | undefined): Promise<StreamEvent[]> => {
      const { harness } = harnessWith({});
      const broadcaster = new EventBroadcaster();
      const ctx = harness.createContext({
        _broadcaster: broadcaster,
      });
      await execute(
        step.decide({
          id: 'quiet',
          model: 'm/x',
          emit,
          questions: QUESTIONS,
        }),
        'x',
        ctx,
      );
      broadcaster.complete();
      const events: StreamEvent[] = [];
      for await (const e of broadcaster) {
        events.push(e);
      }
      return events;
    };
    expect(await eventsFor(false)).toHaveLength(0);
    expect((await eventsFor(undefined)).length).toBeGreaterThan(0);
  });
});

function frameworkRecord(value: unknown): Record<
  string,
  {
    stepId: string;
    source: string;
  }
> {
  assert(typeof value === 'object' && value !== null);
  return frameworkCast<
    Record<
      string,
      {
        stepId: string;
        source: string;
      }
    >
  >(value);
}
