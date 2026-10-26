// `conditional` routes with an `expr` test: a JSONata expression that takes
// the route on `true`, as the exact alternative to a substring `match`.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { DecideResponse, WorkflowDocument, WorkflowNode } from '@noetic-tools/types';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import { hydrateNode } from '../../src/builders/workflow-hydrator';
import { expressionErrors } from '../../src/expression/check';
import { AgentHarness } from '../../src/harness/agent-harness';
import { WorkflowNodeSchema } from '../../src/schemas/workflow';
import { makeMockContext, noRun } from '../_helpers';

//#region Helpers

/** A leaf that outputs `text`, so a run's output names the route it took. */
function say(id: string, text: string): WorkflowNode {
  return {
    kind: 'compute',
    id,
    expr: JSON.stringify(text),
  };
}

function route(
  test:
    | {
        expr: string;
      }
    | {
        match: string;
      },
  label: string,
) {
  return {
    ...test,
    target: say(label, label),
  };
}

const NUMBER_ROUTES: WorkflowNode = {
  kind: 'conditional',
  id: 'pick',
  routes: [
    route(
      {
        expr: 'n = 0',
      },
      'zero',
    ),
    route(
      {
        expr: 'n > 3',
      },
      'big',
    ),
  ],
  default: say('small', 'small'),
};

function makeHarness(decide?: () => DecideResponse): AgentHarness {
  return new AgentHarness({
    name: 'conditional-expr-test',
    params: {},
    _testDecide: decide ? async () => decide() : undefined,
  });
}

async function runDoc(
  root: WorkflowNode,
  input: string,
  opts?: {
    workflows?: ReadonlyMap<string, WorkflowDocument>;
    decide?: () => DecideResponse;
  },
): Promise<string> {
  const harness = makeHarness(opts?.decide);
  return parseAndRunWorkflow({
    json: {
      version: 1,
      root,
    },
    harness,
    ctx: harness.createContext(),
    tools: [],
    input,
    workflows: opts?.workflows,
  });
}

/** The route the hydrated conditional picks for `input`, by target id. */
async function pick(node: WorkflowNode, input: string): Promise<string | null> {
  const step = hydrateNode(node, {
    tools: new Map(),
    executeStep: noRun,
  });
  assert(step.kind === 'conditional');
  const target = await step.route(input, makeMockContext(), noRun);
  return target ? target.id : null;
}

/** Each recursion level is a step, so a failure nests one `step_failed` per level. */
function rootCause(error: unknown): unknown {
  let current = error;
  while (isNoeticError(current) && current.noeticError.kind === 'step_failed') {
    current = current.noeticError.cause;
  }
  return current;
}

function triageAnswer(destination: string): DecideResponse {
  return {
    answers: {
      destination: {
        type: 'choice',
        value: destination,
        confidence: 0.9,
        probabilities: {
          billing: destination === 'billing' ? 0.9 : 0.1,
          sales: destination === 'sales' ? 0.9 : 0.1,
        },
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

describe('conditional route schema', () => {
  const target = say('t', 't');

  it('accepts a route with exactly one of match or expr', () => {
    for (const test of [
      {
        match: 'yes',
      },
      {
        expr: 'n > 3',
      },
    ]) {
      const node = {
        kind: 'conditional',
        id: 'c',
        routes: [
          {
            ...test,
            target,
          },
        ],
      };
      expect(WorkflowNodeSchema.safeParse(node).success).toBe(true);
    }
  });

  it('rejects a route with both match and expr, or neither', () => {
    for (const test of [
      {
        match: 'yes',
        expr: 'n > 3',
      },
      {},
    ]) {
      const result = WorkflowNodeSchema.safeParse({
        kind: 'conditional',
        id: 'c',
        routes: [
          {
            ...test,
            target,
          },
        ],
      });
      expect(result.success).toBe(false);
      assert(!result.success);
      expect(result.error.issues.map((i) => i.message).join('\n')).toContain(
        "exactly one of 'match' (substring) or 'expr' (expression)",
      );
    }
  });

  it('parseAndRunWorkflow rejects a route with both tests before running', async () => {
    try {
      await runDoc(
        {
          kind: 'conditional',
          id: 'c',
          routes: [
            {
              match: 'yes',
              expr: 'n > 3',
              target,
            },
          ],
        },
        '{}',
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('WORKFLOW_VALIDATION_FAILED');
    }
  });
});

describe('conditional expr routing', () => {
  it('routes on numeric comparisons against the parsed JSON input', async () => {
    expect(await runDoc(NUMBER_ROUTES, '{"n":0}')).toBe('zero');
    expect(await runDoc(NUMBER_ROUTES, '{"n":7}')).toBe('big');
  });

  it('takes the default when no route passes, at the n > 3 boundary', async () => {
    expect(await runDoc(NUMBER_ROUTES, '{"n":3}')).toBe('small');
    expect(await runDoc(NUMBER_ROUTES, '{"n":4}')).toBe('big');
    expect(await runDoc(NUMBER_ROUTES, '{"n":2}')).toBe('small');
  });

  it('skips a route whose path matches nothing', async () => {
    expect(await pick(NUMBER_ROUTES, '{"other":1}')).toBe('small');
  });

  it('returns null when no route passes and there is no default', async () => {
    const node: WorkflowNode = {
      kind: 'conditional',
      id: 'pick',
      routes: [
        route(
          {
            expr: 'n = 0',
          },
          'zero',
        ),
      ],
    };
    expect(await pick(node, '{"n":1}')).toBeNull();
  });

  it('tries match and expr routes in order, first pass wins', async () => {
    const node: WorkflowNode = {
      kind: 'conditional',
      id: 'pick',
      routes: [
        route(
          {
            match: 'urgent',
          },
          'by-match',
        ),
        route(
          {
            expr: 'n > 3',
          },
          'by-expr',
        ),
        route(
          {
            match: 'later',
          },
          'by-late-match',
        ),
      ],
      default: say('none', 'none'),
    };
    expect(await pick(node, '{"note":"urgent","n":9}')).toBe('by-match');
    expect(await pick(node, '{"note":"calm","n":9}')).toBe('by-expr');
    expect(await pick(node, '{"note":"later","n":1}')).toBe('by-late-match');
    expect(await pick(node, '{"note":"calm","n":1}')).toBe('none');
  });

  it('reads a non-JSON string input as the raw string', async () => {
    const node: WorkflowNode = {
      kind: 'conditional',
      id: 'pick',
      routes: [
        route(
          {
            expr: '$ = "go"',
          },
          'go',
        ),
      ],
    };
    expect(await pick(node, 'go')).toBe('go');
    expect(await pick(node, 'stop')).toBeNull();
  });

  it('fails with EXPRESSION_FAILED when a test gives a non-boolean', async () => {
    const node: WorkflowNode = {
      kind: 'conditional',
      id: 'pick',
      routes: [
        route(
          {
            expr: 'n',
          },
          'never',
        ),
      ],
    };
    try {
      await pick(node, '{"n":1}');
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('EXPRESSION_FAILED');
      expect(e.message).toContain("route 0 of conditional node 'pick'");
      expect(e.message).toContain('got number');
    }
  });

  it('fails a run with EXPRESSION_FAILED when a test gives a non-boolean', async () => {
    const node: WorkflowNode = {
      kind: 'conditional',
      id: 'pick',
      routes: [
        route(
          {
            expr: '"yes"',
          },
          'never',
        ),
      ],
    };
    try {
      await runDoc(node, '{}');
      expect.unreachable('should have thrown');
    } catch (e) {
      const cause = rootCause(e);
      assert(isNoeticConfigError(cause));
      expect(cause.code).toBe('EXPRESSION_FAILED');
    }
  });
});

describe('conditional expr syntax', () => {
  const broken: WorkflowNode = {
    kind: 'conditional',
    id: 'pick',
    routes: [
      route(
        {
          match: 'fine',
        },
        'fine',
      ),
      route(
        {
          expr: 'n >',
        },
        'broken',
      ),
    ],
  };

  it('expressionErrors names the route that does not parse', () => {
    const errors = expressionErrors(broken);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("route 1 of conditional node 'pick' does not parse");
  });

  it('parseAndRunWorkflow fails validation with WORKFLOW_VALIDATION_FAILED', async () => {
    try {
      await runDoc(broken, '{}');
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('WORKFLOW_VALIDATION_FAILED');
    }
  });

  it('hydrateNode throws WORKFLOW_VALIDATION_FAILED for a route that does not parse', () => {
    try {
      hydrateNode(broken, {
        tools: new Map(),
        executeStep: noRun,
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('WORKFLOW_VALIDATION_FAILED');
    }
  });
});

describe('conditional expr on structured state', () => {
  it("routes on a decide node's answers passed by a sequence", async () => {
    const triage = (destination: string): Promise<string> =>
      runDoc(
        {
          kind: 'sequence',
          id: 'flow',
          steps: [
            {
              kind: 'decide',
              id: 'triage',
              model: 'typesafe/jev-1.14',
              questions: {
                destination: {
                  type: 'choice',
                  instructions: 'Which team?',
                  choices: [
                    'billing',
                    'sales',
                  ],
                },
              },
            },
            {
              kind: 'conditional',
              id: 'send',
              routes: [
                route(
                  {
                    expr: 'destination.value = "billing"',
                  },
                  'to-billing',
                ),
              ],
              default: say('to-sales', 'to-sales'),
            },
          ],
        },
        'I was charged twice',
        {
          decide: () => triageAnswer(destination),
        },
      );
    expect(await triage('billing')).toBe('to-billing');
    expect(await triage('sales')).toBe('to-sales');
  });

  it('ends a recursive named workflow at an expr base case', async () => {
    // `countdown` adds n to the total and calls itself with n - 1 until n is 0.
    const workflows = new Map<string, WorkflowDocument>([
      [
        'countdown',
        {
          version: 1,
          root: {
            kind: 'conditional',
            id: 'check',
            routes: [
              {
                expr: 'n = 0',
                target: {
                  kind: 'compute',
                  id: 'done',
                  expr: '{ "total": total }',
                },
              },
            ],
            default: {
              kind: 'sequence',
              id: 'step',
              steps: [
                {
                  kind: 'compute',
                  id: 'next',
                  expr: '{ "n": n - 1, "total": total + n }',
                },
                {
                  kind: 'subflow',
                  id: 'again',
                  ref: 'countdown',
                },
              ],
            },
          },
        },
      ],
    ]);
    const call: WorkflowNode = {
      kind: 'subflow',
      id: 'top',
      ref: 'countdown',
    };
    expect(
      await runDoc(call, '{"n":4,"total":0}', {
        workflows,
      }),
    ).toBe('{"total":10}');
    expect(
      await runDoc(call, '{"n":0,"total":0}', {
        workflows,
      }),
    ).toBe('{"total":0}');
  });
});

//#endregion
