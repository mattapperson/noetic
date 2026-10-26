// The `expr` until predicate: a JSONata expression over the loop's last
// output that stops the loop when it gives `true` (spec 26, spec 33).

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { DecideResponse, Snapshot, Until } from '@noetic-tools/types';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import { hydrateNode } from '../../src/builders/workflow-hydrator';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { UntilPredicate, WorkflowNode } from '../../src/schemas/workflow';
import { UntilPredicateSchema } from '../../src/schemas/workflow';
import { noRun } from '../_helpers';

//#region Helpers

const DRAIN = {
  kind: 'expr',
  expr: 'n = 0',
} as const satisfies UntilPredicate;

/** A loop whose body counts `n` down by one each iteration. */
function countdown(until: UntilPredicate, maxIterations?: number | 'infinity'): WorkflowNode {
  return {
    kind: 'loop',
    id: 'drain',
    body: {
      kind: 'compute',
      id: 'step',
      expr: '{ "n": n - 1 }',
    },
    until,
    maxIterations,
  };
}

/** Runs `countdown` from `start` through a real harness and returns the final `n`. */
async function runCountdown(
  start: number,
  until: UntilPredicate,
  opts: {
    maxIterations?: number | 'infinity';
    harness?: AgentHarness;
  } = {},
): Promise<unknown> {
  const harness =
    opts.harness ??
    new AgentHarness({
      name: 'json-until-expr',
      params: {},
    });
  const output = await parseAndRunWorkflow({
    json: {
      version: 1,
      root: countdown(until, opts.maxIterations),
    },
    harness,
    ctx: harness.createContext(),
    tools: [],
    input: JSON.stringify({
      n: start,
    }),
  });
  const parsed: {
    n: unknown;
  } = JSON.parse(output);
  return parsed.n;
}

/** The hydrated `until` of a countdown loop, as a plain predicate. */
function hydratedUntil(pred: UntilPredicate): Until {
  const step = hydrateNode(countdown(pred), {
    tools: new Map(),
    executeStep: noRun,
  });
  assert(step.kind === 'loop');
  assert(typeof step.until === 'function');
  return step.until;
}

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

function noDecision(): DecideResponse {
  return {
    answers: {
      stop: {
        type: 'boolean',
        value: false,
        probability: 0.1,
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

//#endregion

//#region Tests

describe('expr until predicate: schema', () => {
  it('accepts an expression, alone and nested in any/all', () => {
    expect(UntilPredicateSchema.safeParse(DRAIN).success).toBe(true);
    expect(
      UntilPredicateSchema.safeParse({
        kind: 'any',
        predicates: [
          {
            kind: 'all',
            predicates: [
              DRAIN,
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  for (const invalid of [
    {
      kind: 'expr',
    },
    {
      kind: 'expr',
      expr: '',
    },
    {
      kind: 'expr',
      test: 'n = 0',
    },
    {
      kind: 'when',
      test: 'n = 0',
    },
  ]) {
    it(`rejects ${JSON.stringify(invalid)}`, () => {
      expect(UntilPredicateSchema.safeParse(invalid).success).toBe(false);
    });
  }
});

describe('expr until predicate: hydration', () => {
  it('stops on true, reading a JSON string output as JSON', async () => {
    expect(await hydratedUntil(DRAIN)(snapshot('{"n":0}'))).toEqual({
      stop: true,
      reason: 'expr gave true: n = 0',
    });
  });

  it('continues on false', async () => {
    expect(await hydratedUntil(DRAIN)(snapshot('{"n":1}'))).toEqual({
      stop: false,
      reason: undefined,
    });
  });

  it('reads a non-string output as is', async () => {
    const verdict = await hydratedUntil(DRAIN)(
      snapshot({
        n: 0,
      }),
    );
    expect(verdict.stop).toBe(true);
  });

  it('reads a string that is not JSON as the raw string', async () => {
    const verdict = await hydratedUntil({
      kind: 'expr',
      expr: '$ = "done"',
    })(snapshot('done'));
    expect(verdict.stop).toBe(true);
  });

  it('continues when the path matches nothing', async () => {
    const verdict = await hydratedUntil(DRAIN)(snapshot('{"m":0}'));
    expect(verdict.stop).toBe(false);
  });

  it('throws EXPRESSION_FAILED naming the loop when the result is not a boolean', async () => {
    const error = await Promise.resolve(
      hydratedUntil({
        kind: 'expr',
        expr: 'n',
      })(snapshot('{"n":3}')),
    ).catch((e: unknown) => e);
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('EXPRESSION_FAILED');
    expect(error.message).toContain("until of loop node 'drain'");
    expect(error.message).toContain('got number');
  });
});

describe('expr until predicate: end to end', () => {
  // Counting down from 3 reaches n = 0 on iteration 3: a cap of 2 proves the
  // loop did not stop early, and caps of 3 and 4 that it stopped exactly there.
  it('needs N iterations: a cap of N - 1 fails', async () => {
    const error = await runCountdown(3, DRAIN, {
      maxIterations: 2,
    }).catch((e: unknown) => e);
    assert(isNoeticError(error));
    expect(error.noeticError.kind).toBe('step_failed');
  });

  it('stops at iteration N under a cap of exactly N', async () => {
    expect(
      await runCountdown(3, DRAIN, {
        maxIterations: 3,
      }),
    ).toBe(0);
  });

  it('does not run iteration N + 1 under a cap of N + 1', async () => {
    expect(
      await runCountdown(3, DRAIN, {
        maxIterations: 4,
      }),
    ).toBe(0);
  });

  it('fails the loop when the expression gives a non-boolean', async () => {
    const error = await runCountdown(3, {
      kind: 'expr',
      expr: 'n',
    }).catch((e: unknown) => e);
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('EXPRESSION_FAILED');
  });

  it('inside any, maxSteps stops first when it is lower', async () => {
    const pred: UntilPredicate = {
      kind: 'any',
      predicates: [
        DRAIN,
        {
          kind: 'maxSteps',
          n: 2,
        },
      ],
    };
    expect(await runCountdown(5, pred)).toBe(3);
    expect(await runCountdown(1, pred)).toBe(0);
  });

  it('inside all, stops only once both agree', async () => {
    expect(
      await runCountdown(3, {
        kind: 'all',
        predicates: [
          DRAIN,
          {
            kind: 'maxSteps',
            n: 1,
          },
        ],
      }),
    ).toBe(0);
  });

  it('inside any beside a decide node that keeps answering no', async () => {
    let asked = 0;
    const harness = new AgentHarness({
      name: 'json-until-expr-decide',
      params: {},
      _testDecide: async () => {
        asked++;
        return noDecision();
      },
    });
    const n = await runCountdown(
      3,
      {
        kind: 'any',
        predicates: [
          {
            kind: 'decide',
            id: 'done',
            model: 'typesafe/jev-1.14',
            questions: {
              stop: {
                type: 'boolean',
                instructions: 'Is the work done?',
              },
            },
          },
          DRAIN,
        ],
      },
      {
        harness,
      },
    );
    expect(n).toBe(0);
    expect(asked).toBe(3);
  });

  it('ends an uncapped loop after more than 1000 iterations', async () => {
    expect(
      await runCountdown(1500, DRAIN, {
        maxIterations: 'infinity',
      }),
    ).toBe(0);
  });

  it('rejects a syntax error nested in any with WORKFLOW_VALIDATION_FAILED', async () => {
    const error = await runCountdown(3, {
      kind: 'any',
      predicates: [
        {
          kind: 'maxSteps',
          n: 3,
        },
        {
          kind: 'all',
          predicates: [
            {
              kind: 'expr',
              expr: 'n = = 0',
            },
          ],
        },
      ],
    }).catch((e: unknown) => e);
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('WORKFLOW_VALIDATION_FAILED');
    expect(error.message).toContain("until of loop node 'drain'");
  });
});

//#endregion
