// The `compute` node evaluates a JSONata expression against its input with no
// LLM. These tests cover its schema, its place in the tree helpers, hydration,
// and real runs through a harness — alone, chained, in loops, in dynamic
// fan-out, and inside named sub-workflows.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { WorkflowDocument, WorkflowNode } from '@noetic-tools/types';
import {
  frameworkCast,
  hashString,
  isNoeticConfigError,
  isNoeticError,
  WorkflowNodeSchema,
  walkWorkflow,
  workflowDepth,
  workflowGraph,
} from '@noetic-tools/types';
import { parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import type { HydrationContext } from '../../src/builders/workflow-hydrator';
import { hydrateNode } from '../../src/builders/workflow-hydrator';
import { compileExpression, compute } from '../../src/expression/jsonata';
import { AgentHarness } from '../../src/harness/agent-harness';
import { makeMockContext } from '../_helpers';

//#region Helpers

function node(id: string, expr: string): WorkflowNode {
  return {
    kind: 'compute',
    id,
    expr,
  };
}

async function run(
  root: WorkflowNode,
  input: string,
  workflows?: ReadonlyMap<string, WorkflowDocument>,
): Promise<string> {
  const harness = new AgentHarness({
    name: 'compute-test',
    params: {},
  });
  return parseAndRunWorkflow({
    json: {
      version: 1,
      root,
    },
    harness,
    ctx: harness.createContext(),
    tools: [],
    input,
    workflows,
  });
}

/** The first error in a `step_failed` chain that is not itself a step failure. */
function rootCause(error: unknown): unknown {
  let current = error;
  while (isNoeticError(current) && current.noeticError.kind === 'step_failed') {
    current = current.noeticError.cause;
  }
  return current;
}

/** Asserts `promise` rejects with a config error of `code`, unwrapping step failures. */
async function expectConfigError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected ${code}`);
  } catch (e) {
    const cause = rootCause(e);
    assert(isNoeticConfigError(cause));
    expect(cause.code).toBe(code);
  }
}

/** Counts `n` down to 0, adding each value to `sum`; marks the final state `done`. */
const SUM_STEP = "n = 0 ? { 'done': true, 'sum': sum } : { 'n': n - 1, 'sum': sum + n }";

//#endregion

//#region Tests

describe('compute schema', () => {
  it('accepts a node with an expression and the shared fields', () => {
    const parsed = WorkflowNodeSchema.safeParse({
      kind: 'compute',
      id: 'step',
      expr: 'n + 1',
      durable: false,
      replayKey: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty expression', () => {
    expect(WorkflowNodeSchema.safeParse(node('step', '')).success).toBe(false);
  });

  it('rejects a missing or non-string expression', () => {
    expect(
      WorkflowNodeSchema.safeParse({
        kind: 'compute',
        id: 'step',
      }).success,
    ).toBe(false);
    expect(
      WorkflowNodeSchema.safeParse({
        kind: 'compute',
        id: 'step',
        expr: {
          '+': [
            1,
            2,
          ],
        },
      }).success,
    ).toBe(false);
  });
});

describe('compute in the tree helpers', () => {
  const tree: WorkflowNode = {
    kind: 'sequence',
    id: 'seq',
    steps: [
      node('a', 'x'),
      node('b', 'x'),
    ],
  };

  it('is a leaf of depth 0', () => {
    expect(workflowDepth(node('a', 'x'))).toBe(0);
    expect(workflowDepth(tree)).toBe(1);
  });

  it('walks and graphs as a leaf', () => {
    expect(
      [
        ...walkWorkflow(tree),
      ].map((node) => node.id),
    ).toEqual([
      'seq',
      'a',
      'b',
    ]);
    expect(workflowGraph(tree).edges).toEqual([
      {
        from: 'seq',
        to: 'a',
      },
      {
        from: 'seq',
        to: 'b',
      },
    ]);
  });
});

describe('compute()', () => {
  const where = "compute node 'step'";

  it('returns the raw value, a sequence included', async () => {
    const expr = compileExpression('items.(price * qty)', where);
    expect(
      await compute(expr, {
        items: [
          {
            price: 2,
            qty: 3,
          },
          {
            price: 5,
            qty: 1,
          },
        ],
      }),
    ).toEqual([
      6,
      5,
    ]);
  });

  it('throws EXPRESSION_FAILED for no value or a function at any depth', async () => {
    for (const source of [
      'missing',
      '$uppercase',
      'function($x) { $x }',
      "{ 'a': [1, { 'f': $uppercase }] }",
    ]) {
      try {
        await compute(compileExpression(source, where), {});
        expect.unreachable(`expected EXPRESSION_FAILED for ${source}`);
      } catch (e) {
        assert(isNoeticConfigError(e));
        expect(e.code).toBe('EXPRESSION_FAILED');
        expect(e.message).toContain(where);
      }
    }
  });
});

describe('compute hydration', () => {
  const ctx: HydrationContext = {
    tools: new Map(),
    executeStep: async (_step, input) => frameworkCast(input),
  };

  it('hydrates to a step named by the node id', () => {
    expect(hydrateNode(node('step', 'n + 1'), ctx).id).toBe('step');
  });

  it('carries durable and replayKey onto the step', () => {
    const step = hydrateNode(
      {
        kind: 'compute',
        id: 'step',
        expr: 'n + 1',
        durable: false,
        replayKey: true,
      },
      ctx,
    );
    expect(step.durable).toBe(false);
    assert(step.replayKey);
    expect(step.replayKey('{"n":1}', makeMockContext())).toBe(`step:${hashString('{"n":1}')}`);
  });

  it('throws WORKFLOW_VALIDATION_FAILED when the expression does not parse', () => {
    try {
      hydrateNode(node('step', 'n +'), ctx);
      expect.unreachable('expected WORKFLOW_VALIDATION_FAILED');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('WORKFLOW_VALIDATION_FAILED');
      expect(e.message).toContain("compute node 'step'");
    }
  });
});

describe('compute execution', () => {
  it('reads JSON input as structured data', async () => {
    expect(await run(node('step', 'a + b'), '{"a":2,"b":3}')).toBe('5');
  });

  it('reads input that is not JSON as a raw string', async () => {
    expect(await run(node('step', '$uppercase($)'), 'hello')).toBe('HELLO');
  });

  it('writes an object as JSON', async () => {
    expect(await run(node('step', "{ 'total': a + b }"), '{"a":2,"b":3}')).toBe('{"total":5}');
  });

  it('writes an array as JSON', async () => {
    expect(
      await run(
        node('step', 'items.(price * qty)'),
        '{"items":[{"price":2,"qty":3},{"price":5,"qty":1}]}',
      ),
    ).toBe('[6,5]');
  });

  it('writes a number and a boolean as JSON', async () => {
    expect(await run(node('step', '1.5 * 2'), '{}')).toBe('3');
    expect(await run(node('step', 'a > 1'), '{"a":2}')).toBe('true');
  });

  it('writes a string as is, without JSON quotes', async () => {
    expect(await run(node('step', "'n=' & $string(n)"), '{"n":4}')).toBe('n=4');
  });

  it('writes null as the empty string', async () => {
    expect(await run(node('step', 'null'), '{}')).toBe('');
  });

  it('chains: the next compute reads the previous output as JSON', async () => {
    const root: WorkflowNode = {
      kind: 'sequence',
      id: 'seq',
      steps: [
        node('a', "{ 'n': n * 2 }"),
        node('b', 'n + 1'),
      ],
    };
    expect(await run(root, '{"n":5}')).toBe('11');
  });

  it('fails with EXPRESSION_FAILED when the expression gives no value', async () => {
    await expectConfigError(run(node('step', 'missing.path'), '{"n":1}'), 'EXPRESSION_FAILED');
  });

  it('fails with EXPRESSION_FAILED when the expression gives a function', async () => {
    await expectConfigError(run(node('step', '$uppercase'), '{}'), 'EXPRESSION_FAILED');
    await expectConfigError(run(node('step', 'function($x) { $x }'), '{}'), 'EXPRESSION_FAILED');
  });

  it('fails with EXPRESSION_FAILED when a function sits inside the result', async () => {
    await expectConfigError(
      run(node('step', "{ 'f': function($x) { $x } }"), '{}'),
      'EXPRESSION_FAILED',
    );
    await expectConfigError(run(node('step', '[1, $uppercase]'), '{}'), 'EXPRESSION_FAILED');
  });

  it('fails with EXPRESSION_FAILED when evaluation throws', async () => {
    await expectConfigError(run(node('step', "$error('boom')"), '{}'), 'EXPRESSION_FAILED');
  });

  it('a syntax error fails validation before anything runs', async () => {
    await expectConfigError(run(node('step', '{ n: '), '{}'), 'WORKFLOW_VALIDATION_FAILED');
  });
});

describe('compute in loops', () => {
  it('a loop with a compute body sums 1..n and stops on its marker', async () => {
    const root: WorkflowNode = {
      kind: 'loop',
      id: 'count',
      body: node('step', SUM_STEP),
      until: {
        kind: 'outputContains',
        marker: '"done"',
      },
    };
    expect(await run(root, '{"n":5,"sum":0}')).toBe('{"done":true,"sum":15}');
  });

  it('maxSteps stops a compute loop after that many iterations', async () => {
    const root: WorkflowNode = {
      kind: 'loop',
      id: 'count',
      body: node('step', "{ 'i': i + 1 }"),
      until: {
        kind: 'maxSteps',
        n: 3,
      },
    };
    expect(await run(root, '{"i":0}')).toBe('{"i":3}');
  });

  it('maxIterations "infinity" lets a compute loop run past 1000 iterations', async () => {
    const root: WorkflowNode = {
      kind: 'loop',
      id: 'count',
      body: node('step', "i < 1500 ? { 'i': i + 1 } : 'stop'"),
      until: {
        kind: 'outputEquals',
        sentinel: 'stop',
      },
      maxIterations: 'infinity',
    };
    expect(await run(root, '{"i":0}')).toBe('stop');
  });
});

describe('compute in dynamic fan-out and sub-workflows', () => {
  it('runs once per item of a dynamic inParallel', async () => {
    const root: WorkflowNode = {
      kind: 'inParallel',
      id: 'fan',
      mode: 'all',
      each: node('double', "{ 'v': v * 2 }"),
      merge: 'concat',
    };
    const out = await run(root, '[{"v":1},{"v":2},{"v":3}]');
    expect(out).toContain('{"v":2}');
    expect(out).toContain('{"v":4}');
    expect(out).toContain('{"v":6}');
  });

  it('runs inside a named sub-workflow', async () => {
    const workflows = new Map<string, WorkflowDocument>([
      [
        'double',
        {
          version: 1,
          root: node('step', 'n * 2'),
        },
      ],
    ]);
    const root: WorkflowNode = {
      kind: 'subflow',
      id: 'call',
      ref: 'double',
    };
    expect(await run(root, '{"n":21}', workflows)).toBe('42');
  });
});

//#endregion
