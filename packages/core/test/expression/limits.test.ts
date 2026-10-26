// Evaluation limits on JSONata expressions: each bound trips with
// EXPRESSION_LIMIT_EXCEEDED, raising or lifting it (Infinity) lets the same
// expression through, and bad limit values fail with INVALID_EXPRESSION_LIMITS.

import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import type { ExpressionLimits } from '../../src/expression/jsonata';
import { compileExpression, DEFAULT_EXPRESSION_LIMITS } from '../../src/expression/jsonata';
import { AgentHarness } from '../../src/harness/agent-harness';

//#region Helpers

const NO_LIMITS: Required<ExpressionLimits> = {
  timeout: Number.POSITIVE_INFINITY,
  depth: Number.POSITIVE_INFINITY,
  length: Number.POSITIVE_INFINITY,
  steps: Number.POSITIVE_INFINITY,
};

/** Never ends: JSONata runs the tail call in a loop, so depth stays flat. */
const ENDLESS_TAIL = '( $f := function($n){ $f($n + 1) }; $f(0) )';
/** Never ends, nesting one level per call. */
const ENDLESS_NESTED = '( $f := function($n){ 1 + $f($n + 1) }; $f(0) )';
/** Counts down from `n` in tail position. */
const countdown = (n: number): string =>
  `( $f := function($n){ $n = 0 ? 0 : $f($n - 1) }; $f(${n}) )`;
/** Recurses `n` levels deep, not in tail position. */
const nested = (n: number): string =>
  `( $f := function($n){ $n = 0 ? 0 : 1 + $f($n - 1) }; $f(${n}) )`;
/** Three literals under two binary nodes: 3 levels deep, 5 sub-expressions. */
const SUM = '1 + 2 + 3';

function run(source: string, limits?: ExpressionLimits): Promise<unknown> {
  return compileExpression(source, 'test', limits).run({});
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<string> {
  try {
    await promise;
  } catch (e) {
    assert(isNoeticConfigError(e));
    expect(e.code).toBe(code);
    return e.message;
  }
  return expect.unreachable(`expected ${code}`);
}

/** Times `promise` and checks it fails with EXPRESSION_LIMIT_EXCEEDED, returning the message and duration. */
async function expectExceeded(promise: Promise<unknown>): Promise<{
  message: string;
  ms: number;
}> {
  const start = performance.now();
  const message = await expectCode(promise, 'EXPRESSION_LIMIT_EXCEEDED');
  return {
    message,
    ms: performance.now() - start,
  };
}

//#endregion

//#region Tests

describe('depth', () => {
  test('endless nested recursion trips the default depth fast', async () => {
    const { message, ms } = await expectExceeded(run(ENDLESS_NESTED));
    expect(message).toContain(`depth limit of ${DEFAULT_EXPRESSION_LIMITS.depth}`);
    expect(ms).toBeLessThan(500);
  });

  test('depth boundary: N-1 trips, N and N+1 pass', async () => {
    await expectExceeded(
      run(SUM, {
        depth: 2,
      }),
    );
    expect(
      await run(SUM, {
        depth: 3,
      }),
    ).toBe(6);
    expect(
      await run(SUM, {
        depth: 4,
      }),
    ).toBe(6);
  });

  test('raising depth lets deep recursion through', async () => {
    await expectExceeded(run(nested(200)));
    expect(
      await run(nested(200), {
        depth: 5e3,
      }),
    ).toBe(200);
  });

  test('depth: Infinity lifts the bound', async () => {
    expect(
      await run(nested(200), {
        depth: Number.POSITIVE_INFINITY,
      }),
    ).toBe(200);
  });
});

describe('native stack', () => {
  test('a built-in walking deeply nested input trips a limit instead of crashing', async () => {
    let deep: unknown = 0;
    for (let i = 0; i < 1e6; i++) {
      deep = {
        a: deep,
      };
    }
    for (const source of [
      '$string($)',
      '$count(**)',
    ]) {
      const { message } = await expectExceeded(compileExpression(source, 'test').run(deep));
      expect(message).toContain('JavaScript call stack');
    }
  });
});

describe('steps', () => {
  test('endless tail recursion trips the default step budget with no timeout', async () => {
    const { message } = await expectExceeded(
      run(ENDLESS_TAIL, {
        timeout: Number.POSITIVE_INFINITY,
      }),
    );
    expect(message).toContain(`steps limit of ${DEFAULT_EXPRESSION_LIMITS.steps}`);
  });

  test('steps boundary: N-1 trips, N and N+1 pass', async () => {
    await expectExceeded(
      run(SUM, {
        steps: 4,
      }),
    );
    expect(
      await run(SUM, {
        steps: 5,
      }),
    ).toBe(6);
    expect(
      await run(SUM, {
        steps: 6,
      }),
    ).toBe(6);
  });

  test('raising steps lets a long countdown through', async () => {
    const { message } = await expectExceeded(
      run(countdown(1e3), {
        steps: 1e3,
      }),
    );
    expect(message).toContain('steps limit of 1000');
    expect(
      await run(countdown(1e3), {
        steps: 1e5,
      }),
    ).toBe(0);
  });

  test('steps: Infinity lifts the bound', async () => {
    expect(
      await run(countdown(1e3), {
        steps: Number.POSITIVE_INFINITY,
      }),
    ).toBe(0);
  });

  test('each evaluation gets its own budget, even when runs overlap', async () => {
    const expr = compileExpression(countdown(100), 'test', {
      steps: 1e3,
    });
    // One run needs well over half the budget, so a shared count would trip.
    const results = await Promise.all([
      expr.run({}),
      expr.run({}),
      expr.run({}),
    ]);
    expect(results).toEqual([
      0,
      0,
      0,
    ]);
    expect(await expr.run({})).toBe(0);
  });
});

describe('timeout', () => {
  test('endless tail recursion trips the default timeout', async () => {
    const { message, ms } = await expectExceeded(
      run(ENDLESS_TAIL, {
        steps: Number.POSITIVE_INFINITY,
      }),
    );
    expect(message).toContain(`timeout limit of ${DEFAULT_EXPRESSION_LIMITS.timeout}`);
    expect(ms).toBeGreaterThanOrEqual(DEFAULT_EXPRESSION_LIMITS.timeout);
    expect(ms).toBeLessThan(DEFAULT_EXPRESSION_LIMITS.timeout + 1e3);
  });

  test('a custom timeout trips sooner', async () => {
    const { message, ms } = await expectExceeded(
      run(ENDLESS_TAIL, {
        timeout: 50,
        steps: Number.POSITIVE_INFINITY,
      }),
    );
    expect(message).toContain('timeout limit of 50');
    expect(ms).toBeLessThan(500);
  });

  test('raising the timeout, or Infinity, lets a long loop finish', async () => {
    const loop = '$count([1..2e4].($ * 2))';
    await expectExceeded(
      run(loop, {
        timeout: 1,
      }),
    );
    expect(
      await run(loop, {
        timeout: 6e4,
      }),
    ).toBe(2e4);
    expect(
      await run(loop, {
        timeout: Number.POSITIVE_INFINITY,
      }),
    ).toBe(2e4);
  });

  test('the clock restarts per evaluation', async () => {
    const expr = compileExpression('$count([1..10].($ * 2))', 'test', {
      timeout: 100,
    });
    expect(await expr.run({})).toBe(10);
    await Bun.sleep(150);
    expect(await expr.run({})).toBe(10);
  });
});

describe('length', () => {
  test('a range past the default length trips', async () => {
    const { message } = await expectExceeded(run('$count([1..2e6])'));
    expect(message).toContain(`length limit of ${DEFAULT_EXPRESSION_LIMITS.length}`);
  });

  test('a sequence grown past the default length trips', async () => {
    await expectExceeded(run('$count($append([1..6e5], [1..6e5]))'));
  });

  test('length boundary: N-1 trips, N and N+1 pass', async () => {
    await expectExceeded(
      run('$count([1..10])', {
        length: 9,
      }),
    );
    expect(
      await run('$count([1..10])', {
        length: 10,
      }),
    ).toBe(10);
    expect(
      await run('$count([1..10])', {
        length: 11,
      }),
    ).toBe(10);
  });

  test('raising length, or Infinity, lets a large range through', async () => {
    expect(
      await run('$count([1..2e6])', {
        length: 3e6,
      }),
    ).toBe(2e6);
    expect(
      await run('$count([1..2e6])', {
        length: Number.POSITIVE_INFINITY,
      }),
    ).toBe(2e6);
  });

  test("a huge range trips JSONata's fixed cap even with every limit lifted", async () => {
    const { message, ms } = await expectExceeded(run('[1..1e8]', NO_LIMITS));
    expect(message).toContain('fixed cap of 1e7');
    expect(ms).toBeLessThan(500);
  });
});

describe('limit values', () => {
  const invalid: [
    keyof ExpressionLimits,
    number,
  ][] = [
    [
      'timeout',
      0,
    ],
    [
      'depth',
      -1,
    ],
    [
      'length',
      1.5,
    ],
    [
      'steps',
      Number.NaN,
    ],
    [
      'depth',
      Number.NEGATIVE_INFINITY,
    ],
  ];
  for (const [name, value] of invalid) {
    test(`${name}: ${value} throws INVALID_EXPRESSION_LIMITS`, () => {
      try {
        compileExpression('1', 'test', {
          [name]: value,
        });
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticConfigError(e));
        expect(e.code).toBe('INVALID_EXPRESSION_LIMITS');
        expect(e.message).toContain(`'${name}'`);
      }
    });
  }

  test('an explicit undefined takes the default', async () => {
    expect(
      await run('1', {
        depth: undefined,
      }),
    ).toBe(1);
  });

  test('1 is the smallest valid value', async () => {
    expect(
      await run('1', {
        timeout: 1,
        depth: 1,
        length: 1,
        steps: 1,
      }),
    ).toBe(1);
  });
});

describe('limits through parseAndRunWorkflow', () => {
  function computeWorkflow(expr: string, expressionLimits?: ExpressionLimits): Promise<string> {
    const harness = new AgentHarness({
      name: 'expression-limits',
      params: {},
    });
    return parseAndRunWorkflow({
      json: {
        version: 1,
        root: {
          kind: 'compute',
          id: 'calc',
          expr,
        },
      },
      harness,
      ctx: harness.createContext(),
      tools: [],
      input: '{}',
      expressionLimits,
    });
  }

  async function expectNodeError(promise: Promise<unknown>, code: string): Promise<void> {
    try {
      await promise;
      expect.unreachable(`expected ${code}`);
    } catch (e) {
      // A compute node runs as a runCode step, so its error arrives as the cause.
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('step_failed');
      assert(e.noeticError.kind === 'step_failed');
      const cause = e.noeticError.cause;
      assert(isNoeticConfigError(cause));
      expect(cause.code).toBe(code);
    }
  }

  test('custom limits reach a compute node', async () => {
    await expectNodeError(
      computeWorkflow(SUM, {
        depth: 2,
      }),
      'EXPRESSION_LIMIT_EXCEEDED',
    );
    expect(
      await computeWorkflow(SUM, {
        depth: 3,
      }),
    ).toBe('6');
  });

  test('defaults apply when no limits are passed', async () => {
    await expectNodeError(computeWorkflow(ENDLESS_NESTED), 'EXPRESSION_LIMIT_EXCEEDED');
  });

  test('a bad limit fails before the workflow runs', async () => {
    try {
      await computeWorkflow('1', {
        steps: 0,
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('INVALID_EXPRESSION_LIMITS');
    }
  });
});

//#endregion
