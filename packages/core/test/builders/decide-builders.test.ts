import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type { Context, DecideAnswer, DecideResponse, Step, StepBranch } from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError } from '@noetic-tools/types';
import { step } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';

//#region Helpers

const QUESTIONS = {
  destination: {
    type: 'choice',
    instructions: 'Which team?',
    choices: [
      'billing',
      'sales',
    ],
  },
  isUrgent: {
    type: 'boolean',
    instructions: 'Is it urgent?',
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent?',
    levels: [
      'low',
      'high',
    ],
  },
} as const;

const DEFAULT_ANSWERS: Record<string, DecideAnswer> = {
  destination: {
    type: 'choice',
    value: 'sales',
    confidence: 0.6,
    probabilities: {
      billing: 0.4,
      sales: 0.6,
    },
  },
  isUrgent: {
    type: 'boolean',
    value: false,
    probability: 0.2,
  },
  urgency: {
    type: 'score',
    value: 0.9,
    level: 'high',
    confidence: 0.5,
    probabilities: {
      low: 0.1,
      high: 0.9,
    },
  },
};

function harnessAnswering(answers: Partial<Record<string, DecideAnswer>>): {
  harness: AgentHarness;
  calls: () => number;
} {
  let calls = 0;
  const harness = new AgentHarness({
    name: 'route-switch-test',
    params: {},
    _testCallModel: async () => {
      throw new Error('not used');
    },
    _testDecide: async (): Promise<DecideResponse> => {
      calls++;
      return {
        answers: {
          ...DEFAULT_ANSWERS,
          ...Object.fromEntries(
            Object.entries(answers).filter(
              (
                e,
              ): e is [
                string,
                DecideAnswer,
              ] => e[1] !== undefined,
            ),
          ),
        },
        source: 'native',
        modelId: 'm/x',
        usage: {
          inputTokens: 1,
          outputTokens: 0,
        },
      };
    },
  });
  return {
    harness,
    calls: () => calls,
  };
}

function echo(label: string) {
  return step.run({
    id: `case-${label}`,
    execute: async (input: string) => `${label}:${input}`,
  });
}

const triage = step.decide({
  id: 'triage',
  model: 'm/x',
  questions: QUESTIONS,
});

async function run<O>(
  answers: Partial<Record<string, DecideAnswer>>,
  routed: Step<ContextData, string, O>,
  input = 'x',
): Promise<O> {
  const { harness } = harnessAnswering(answers);
  return harness.run(routed, input, harness.createContext());
}

function expectConfigError(build: () => unknown, code: string): void {
  try {
    build();
    expect.unreachable();
  } catch (e) {
    assert(isNoeticConfigError(e));
    expect(e.code).toBe(code);
  }
}

const cases = {
  billing: echo('billing'),
  sales: echo('sales'),
};

//#endregion

describe('step.decide', () => {
  it('defaults view to full and samples to 1', () => {
    expect(triage.kind).toBe('decide');
    expect(triage.view).toBe('full');
    expect(triage.samples).toBe(1);
  });

  it('rejects an empty id, an empty model, and bad samples', () => {
    expectConfigError(
      () =>
        step.decide({
          id: ' ',
          questions: QUESTIONS,
        }),
      'EMPTY_STEP_ID',
    );
    expectConfigError(
      () =>
        step.decide({
          id: 'd',
          model: '',
          questions: QUESTIONS,
        }),
      'MISSING_MODEL',
    );
    for (const samples of [
      0,
      1.5,
      -1,
    ]) {
      expectConfigError(
        () =>
          step.decide({
            id: 'd',
            questions: QUESTIONS,
            samples,
          }),
        'INVALID_DECIDE_SAMPLES',
      );
    }
  });

  it('rejects invalid question sets', () => {
    const invalid = [
      {
        q: {
          type: 'boolean',
        },
      },
      {
        q: {
          type: 'choice',
          choices: [],
        },
      },
      {
        q: {
          type: 'choice',
          choices: [
            'a',
            'a',
          ],
        },
      },
      {
        q: {
          type: 'score',
          levels: [
            'only',
          ],
        },
      },
      {
        q: {
          type: 'boolean',
          instructions: 'x',
          threshold: 1.5,
        },
      },
    ] as const;
    for (const questions of invalid) {
      expectConfigError(
        () =>
          step.decide({
            id: 'd',
            questions,
          }),
        'INVALID_DECIDE_QUESTIONS',
      );
    }
    expectConfigError(
      () =>
        step.decide({
          id: 'd',
          // @ts-expect-error an empty question map is a type error
          questions: {},
        }),
      'INVALID_DECIDE_QUESTIONS',
    );
  });

  it('types answers with the literal choice values and level labels', async () => {
    const answers = await run({}, triage);
    assert(answers.destination.type === 'choice');
    const value: 'billing' | 'sales' = answers.destination.value;
    expect(value).toBe('sales');
    expect(answers.destination.probabilities.billing).toBe(0.4);
    assert(answers.urgency.type === 'score');
    const level: 'low' | 'high' = answers.urgency.level;
    expect(level).toBe('high');
    // @ts-expect-error not a choice of this question
    expect(answers.destination.probabilities.support).toBeUndefined();
  });

  it('types numeric record choice keys as their string form', () => {
    const numeric = step.decide({
      id: 'stars',
      questions: {
        stars: {
          type: 'choice',
          choices: {
            1: 'Bad',
            5: 'Great',
          },
        },
      },
    });
    step.routeSwitch({
      id: 'route-stars',
      decide: numeric,
      on: 'stars',
      cases: {
        '1': echo('one'),
        '5': echo('five'),
      },
      uncertain: echo('u'),
    });
    expect(numeric.kind).toBe('decide');
  });

  it('types ctx.context from an annotated selector, without type arguments', () => {
    interface Billing extends ContextData {
      billing: {
        plan: string;
      };
    }
    const withContext = step.decide({
      id: 'plan-aware',
      context: (ctx: Context<Billing>) => ({
        plan: ctx.context.billing.plan,
      }),
      questions: QUESTIONS,
    });
    type Answers = NonNullable<typeof withContext._answers>;
    const destination: Answers['destination']['type'] = 'choice';
    // @ts-expect-error the literal questions survive, so a misspelled question is not a key
    const typo: Answers['destinaton'] = destination;
    expect(typo).toBe('choice');
    expect(withContext.kind).toBe('decide');
  });
});

describe('step.routeSwitch — key form', () => {
  it('routes the original input to the chosen case', async () => {
    const routed = step.routeSwitch({
      id: 'route',
      decide: triage,
      on: 'destination',
      cases,
      uncertain: echo('ask-human'),
    });
    expect(await run({}, routed, 'hi')).toBe('sales:hi');
  });

  it("routes booleans by 'true' / 'false' and scores by level", async () => {
    const byBoolean = step.routeSwitch({
      id: 'route-bool',
      decide: triage,
      on: 'isUrgent',
      cases: {
        true: echo('urgent'),
        false: echo('calm'),
      },
      uncertain: echo('unsure'),
    });
    const byLevel = step.routeSwitch({
      id: 'route-level',
      decide: triage,
      on: 'urgency',
      cases: {
        low: echo('low'),
        high: echo('high'),
      },
      uncertain: echo('unsure'),
    });
    expect(await run({}, byBoolean)).toBe('calm:x');
    expect(await run({}, byLevel)).toBe('high:x');
  });

  it('takes uncertain below minConfidence, and the case at or above it', async () => {
    const routed = step.routeSwitch({
      id: 'route-confident',
      decide: triage,
      on: 'destination',
      cases,
      minConfidence: 0.6,
      uncertain: echo('ask-human'),
    });
    const at = (confidence: number) =>
      run(
        {
          destination: {
            type: 'choice',
            value: 'billing',
            confidence,
            probabilities: {
              billing: 0.9,
              sales: 0.1,
            },
          },
        },
        routed,
      );
    expect(await at(0.59)).toBe('ask-human:x');
    expect(await at(0.6)).toBe('billing:x');
    expect(await at(0.61)).toBe('billing:x');
  });

  it("measures a boolean's confidence as the probability of the side it picked, so threshold counts", async () => {
    const strict = step.decide({
      id: 'strict',
      model: 'm/x',
      questions: {
        safe: {
          type: 'boolean',
          instructions: 'Safe?',
          threshold: 0.9,
        },
      },
    });
    const routed = step.routeSwitch({
      id: 'route-strict',
      decide: strict,
      on: 'safe',
      cases: {
        true: echo('ship'),
        false: echo('hold'),
      },
      minConfidence: 0.8,
      uncertain: echo('unsure'),
    });
    const at = (probability: number) =>
      run(
        {
          safe: {
            type: 'boolean',
            value: probability >= 0.9,
            probability,
          },
        },
        routed,
      );
    // p = 0.85 is below the threshold, so value is false — but the model gives
    // false only 0.15, far under minConfidence.
    expect(await at(0.85)).toBe('unsure:x');
    expect(await at(0.1)).toBe('hold:x');
    expect(await at(0.95)).toBe('ship:x');
  });

  it('takes uncertain on refusal', async () => {
    const routed = step.routeSwitch({
      id: 'route-refused',
      decide: triage,
      on: 'destination',
      cases,
      uncertain: echo('ask-human'),
    });
    expect(
      await run(
        {
          destination: {
            type: 'refusal',
          },
        },
        routed,
      ),
    ).toBe('ask-human:x');
  });

  it('routes a choice named like an Object.prototype key', async () => {
    const odd = step.decide({
      id: 'odd',
      model: 'm/x',
      questions: {
        pick: {
          type: 'choice',
          choices: [
            'constructor',
            'toString',
          ],
        },
      },
    });
    const routed = step.routeSwitch({
      id: 'route-odd',
      decide: odd,
      on: 'pick',
      cases: {
        constructor: echo('ctor'),
        toString: echo('str'),
      },
      uncertain: echo('u'),
    });
    expect(
      await run(
        {
          pick: {
            type: 'choice',
            value: 'toString',
            confidence: 0.9,
            probabilities: {
              constructor: 0.1,
              toString: 0.9,
            },
          },
        },
        routed,
      ),
    ).toBe('str:x');
  });

  it('types the output as the union of every case output', async () => {
    const routed = step.routeSwitch({
      id: 'route-mixed',
      decide: triage,
      on: 'isUrgent',
      cases: {
        true: step.run({
          id: 'count',
          execute: async (input: string) => input.length,
        }),
        false: echo('calm'),
      },
      uncertain: echo('unsure'),
    });
    const typed: StepBranch<ContextData, string, number | string> = routed;
    expect(await run({}, typed)).toBe('calm:x');
  });

  it('rejects a missing or misspelled case, an unknown question, and a missing uncertain — at the type level and at build', () => {
    expectConfigError(
      () =>
        step.routeSwitch({
          id: 'r',
          decide: triage,
          on: 'destination',
          // @ts-expect-error a case is missing
          cases: {
            billing: echo('billing'),
          },
          uncertain: echo('u'),
        }),
      'INCOMPLETE_ROUTE_CASES',
    );
    step.routeSwitch({
      id: 'r-extra',
      decide: triage,
      on: 'destination',
      cases: {
        billing: echo('billing'),
        sales: echo('sales'),
        // @ts-expect-error not an outcome of `destination`
        salse: echo('typo'),
      },
      uncertain: echo('u'),
    });
    expectConfigError(
      () =>
        step.routeSwitch({
          id: 'r',
          decide: triage,
          on: frameworkCast<'destination'>('nope'),
          cases,
          uncertain: echo('u'),
        }),
      'UNKNOWN_ROUTE_QUESTION',
    );
    expectConfigError(
      () =>
        // @ts-expect-error uncertain is required on the key form
        step.routeSwitch({
          id: 'r',
          decide: triage,
          on: 'destination',
          cases,
        }),
      'MISSING_UNCERTAIN_STEP',
    );
    expectConfigError(
      () =>
        step.routeSwitch({
          id: 'r',
          decide: triage,
          on: 'destination',
          cases,
          minConfidence: 1.2,
          uncertain: echo('u'),
        }),
      'INVALID_MIN_CONFIDENCE',
    );
    expectConfigError(
      () =>
        step.routeSwitch({
          id: '',
          decide: triage,
          on: 'destination',
          cases,
          uncertain: echo('u'),
        }),
      'EMPTY_STEP_ID',
    );
  });

  it('lists the decide step and every case as optimizable children', () => {
    const routed = step.routeSwitch({
      id: 'route-children',
      decide: triage,
      on: 'destination',
      cases,
      uncertain: echo('u'),
    });
    expect(routed._optimizable?.map((s) => s.id)).toEqual([
      'triage',
      'case-billing',
      'case-sales',
      'case-u',
    ]);
  });

  it('rebuilds around new children, so the route runs the replacements', async () => {
    const routed = step.routeSwitch({
      id: 'route-rebuild',
      decide: triage,
      on: 'destination',
      cases,
      uncertain: echo('u'),
    });
    assert(routed._rebuild && routed._optimizable);
    const [decideChild, , , uncertain] = routed._optimizable;
    assert(decideChild && uncertain);
    const rebuilt = routed._rebuild(
      frameworkCast<Step<ContextData>[]>([
        decideChild,
        echo('billing-2'),
        echo('sales-2'),
        uncertain,
      ]),
    );
    expect(await run({}, frameworkCast<Step<ContextData, string, string>>(rebuilt))).toBe(
      'sales-2:x',
    );
  });

  it('asks the model once when two switches route on the same decision', async () => {
    const inner = step.routeSwitch({
      id: 'inner',
      decide: triage,
      on: 'destination',
      cases,
      uncertain: echo('u'),
    });
    const outer = step.routeSwitch({
      id: 'outer',
      decide: triage,
      on: 'isUrgent',
      cases: {
        true: echo('page'),
        false: inner,
      },
      uncertain: echo('u'),
    });
    const { harness, calls } = harnessAnswering({});
    expect(await harness.run(outer, 'x', harness.createContext())).toBe('sales:x');
    expect(calls()).toBe(1);
  });
});

describe('step.routeSwitch — function form', () => {
  it('routes by the returned key, falling back to default', async () => {
    const routed = step.routeSwitch({
      id: 'route-fn',
      decide: triage,
      on: (a) => (a.isUrgent.value || a.urgency.value >= 1 ? 'page' : 'queue'),
      cases: {
        page: echo('page'),
      },
      default: echo('default'),
    });
    expect(await run({}, routed)).toBe('default:x');
  });

  it('takes the named case when the function picks it', async () => {
    const routed = step.routeSwitch({
      id: 'route-fn-page',
      decide: triage,
      on: (a) => (a.isUrgent.value ? 'page' : 'queue'),
      cases: {
        page: echo('page'),
        queue: echo('queue'),
      },
      default: echo('default'),
    });
    expect(
      await run(
        {
          isUrgent: {
            type: 'boolean',
            value: true,
            probability: 0.95,
          },
        },
        routed,
      ),
    ).toBe('page:x');
  });

  it('takes uncertain on any refusal, or default without it', async () => {
    const refused = {
      urgency: {
        type: 'refusal',
      },
    } as const;
    const base = {
      decide: triage,
      on: () => 'page' as const,
      cases: {
        page: echo('page'),
      },
      default: echo('default'),
    };
    const withUncertain = step.routeSwitch({
      ...base,
      id: 'route-fn-refused',
      uncertain: echo('unsure'),
    });
    const without = step.routeSwitch({
      ...base,
      id: 'route-fn-refused-bare',
    });
    expect(await run(refused, withUncertain)).toBe('unsure:x');
    expect(await run(refused, without)).toBe('default:x');
  });
});
