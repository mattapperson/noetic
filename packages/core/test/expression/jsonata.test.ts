// The JSONata adapter: compiling, reading input, and turning results and
// failures into Noetic values and errors.

import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import { isNoeticConfigError } from '@noetic-tools/types';
import {
  compileExpression,
  compute,
  passes,
  readInput,
  syntaxError,
} from '../../src/expression/jsonata';

//#region Helpers

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

function compile(source: string): ReturnType<typeof compileExpression> {
  return compileExpression(source, "compute node 'calc'");
}

//#endregion

//#region Tests

describe('compileExpression', () => {
  test('runs against the input', async () => {
    const expr = compile('a + b');
    expect(expr.where).toBe("compute node 'calc'");
    expect(
      await expr.run({
        a: 1,
        b: 2,
      }),
    ).toBe(3);
  });

  test('throws WORKFLOW_VALIDATION_FAILED when the source does not parse', () => {
    try {
      compile('a +');
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('WORKFLOW_VALIDATION_FAILED');
      expect(e.message).toContain("compute node 'calc'");
    }
  });

  test('a JSONata runtime error becomes EXPRESSION_FAILED naming the code', async () => {
    const message = await expectCode(compile('$number("x")').run({}), 'EXPRESSION_FAILED');
    expect(message).toContain("compute node 'calc'");
    expect(message).toContain('D3030');
  });

  test('a JS error thrown by a built-in becomes EXPRESSION_FAILED', async () => {
    // JSONata's $base64encode reaches for Buffer, which some runtimes lack.
    const buffer = globalThis.Buffer;
    Reflect.deleteProperty(globalThis, 'Buffer');
    try {
      const message = await expectCode(compile('$base64encode("hi")').run({}), 'EXPRESSION_FAILED');
      expect(message).toContain('TypeError');
    } finally {
      globalThis.Buffer = buffer;
    }
    expect(await compile('$base64encode("hi")').run({})).toBe('aGk=');
  });
});

describe('syntaxError', () => {
  test('is undefined for a valid expression', () => {
    expect(syntaxError('a.b')).toBeUndefined();
  });

  test('describes the error and its code', () => {
    const error = syntaxError('a +');
    assert(error !== undefined);
    expect(error).toContain('S0');
  });
});

describe('compute', () => {
  test('gives the value', async () => {
    expect(
      await compute(compile('{ "n": n + 1 }'), {
        n: 1,
      }),
    ).toEqual({
      n: 2,
    });
  });

  test('no value throws EXPRESSION_FAILED', async () => {
    const message = await expectCode(compute(compile('missing'), {}), 'EXPRESSION_FAILED');
    expect(message).toContain('gave no value');
  });

  test('a function throws EXPRESSION_FAILED', async () => {
    const message = await expectCode(
      compute(compile('function($x){ $x }'), {}),
      'EXPRESSION_FAILED',
    );
    expect(message).toContain('function');
    await expectCode(compute(compile('$sum'), {}), 'EXPRESSION_FAILED');
    await expectCode(
      compute(compile('f'), {
        f: () => 1,
      }),
      'EXPRESSION_FAILED',
    );
  });

  test('a limit trips with EXPRESSION_LIMIT_EXCEEDED', async () => {
    const expr = compileExpression('[1..10]', 'test', {
      length: 5,
    });
    await expectCode(compute(expr, {}), 'EXPRESSION_LIMIT_EXCEEDED');
  });
});

describe('passes', () => {
  test('true passes and false does not', async () => {
    expect(
      await passes(compile('n > 1'), {
        n: 2,
      }),
    ).toBe(true);
    expect(
      await passes(compile('n > 1'), {
        n: 1,
      }),
    ).toBe(false);
  });

  test('no value does not pass', async () => {
    expect(await passes(compile('missing'), {})).toBe(false);
  });

  test('a non-boolean throws EXPRESSION_FAILED', async () => {
    const message = await expectCode(
      passes(compile('n'), {
        n: 1,
      }),
      'EXPRESSION_FAILED',
    );
    expect(message).toContain('got number');
  });

  test('null and arrays are named in the failure', async () => {
    expect(await expectCode(passes(compile('null'), {}), 'EXPRESSION_FAILED')).toContain(
      'got null',
    );
    expect(await expectCode(passes(compile('[1, 2]'), {}), 'EXPRESSION_FAILED')).toContain(
      'got array',
    );
  });
});

describe('readInput', () => {
  test('parses a JSON string', () => {
    expect(readInput('{"a":1}')).toEqual({
      a: 1,
    });
    expect(readInput('5')).toBe(5);
  });

  test('keeps a string that is not JSON', () => {
    expect(readInput('hello')).toBe('hello');
  });

  test('passes other values through', () => {
    const value = {
      a: 1,
    };
    expect(readInput(value)).toBe(value);
    expect(readInput(undefined)).toBeUndefined();
  });
});

//#endregion
