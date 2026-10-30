import { describe, expect, it } from 'bun:test';
import type { Context, ContextData, DetachedHandle, Step, Steps } from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import {
  AgentHarness,
  callModel,
  conditional,
  inParallel,
  otherwise,
  runCode,
  semanticRoute,
  spawn,
  when,
  withContext,
} from '../../src';
import { toStep } from '../../src/builders/sequence';
import { collectAllTools } from '../../src/interpreter/collect-tools';
import { stepChildren } from '../../src/interpreter/step-walk';
import { makeTestTool } from '../_helpers';

//#region Helpers

function append(id: string, suffix: string): Step<ContextData, string, string> {
  return runCode<ContextData, string, string>({
    id,
    execute: async (input) => `${input}${suffix}`,
  });
}

function length(id: string): Step<ContextData, string, number> {
  return runCode<ContextData, string, number>({
    id,
    execute: async (input) => input.length,
  });
}

function toText(id: string): Step<ContextData, number, string> {
  return runCode<ContextData, number, string>({
    id,
    execute: async (input) => `${input}`,
  });
}

/** The `NoeticConfigError` code `build` throws, or `undefined`. */
function configErrorCode(build: () => unknown): string | undefined {
  try {
    build();
  } catch (error) {
    return error instanceof NoeticConfigError ? error.code : undefined;
  }
  return undefined;
}

/** Passes a step or array through a generic signature, as library code would. */
function runSteps<I, O>(h: AgentHarness, steps: Steps<ContextData, I, O>, input: I): Promise<O> {
  return h.run(steps, input, h.createContext());
}

function harness(): AgentHarness {
  return new AgentHarness({
    name: 'step-arrays',
    params: {},
  });
}

async function runOn<I, O>(step: Step<ContextData, I, O>, input: I): Promise<O> {
  const h = harness();
  return h.run(step, input, h.createContext());
}

//#endregion

describe('toStep', () => {
  it('returns a single step unchanged', () => {
    const a = append('a', '1');
    expect(toStep<ContextData, string, string>(a)).toBe(a);
  });

  it('returns the element of a one-element array', () => {
    const a = append('a', '1');
    expect(
      Object.is(
        toStep([
          a,
        ]),
        a,
      ),
    ).toBe(true);
  });

  it('turns two or more steps into a sequence step that joins their ids', () => {
    const a = append('a', '1');
    const b = append('b', '2');
    const built = toStep([
      a,
      b,
    ]);
    expect(built.kind).toBe('sequence');
    expect(built.id).toBe('a > b');
    expect(stepChildren(frameworkCast<Step>(built)).map((child) => child.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('refuses an empty array with EMPTY_STEP_ARRAY', () => {
    // The Steps type already refuses `[]`; the runtime guard covers untyped callers.
    const empty = frameworkCast<Steps<ContextData, string, string>>([]);
    let caught: unknown;
    try {
      toStep(empty);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NoeticConfigError);
    expect(caught instanceof NoeticConfigError ? caught.code : undefined).toBe('EMPTY_STEP_ARRAY');
  });
});

describe('arrays of steps', () => {
  it('harness.run threads each output into the next step and types the last output', async () => {
    const h = harness();
    const ctx = h.createContext();
    const out: number = await h.run(
      [
        append('a', '-x'),
        append('b', '-y'),
        length('c'),
      ],
      'in',
      ctx,
    );
    expect(out).toBe('in-x-y'.length);
    expect(ctx.itemLog.items).toEqual([]);
  });

  it('types an array from the first step input to the last step output', async () => {
    const h = harness();
    const ctx = h.createContext();
    const chain = [
      append('a', ''),
      length('b'),
    ] as const;
    // @ts-expect-error the first step takes a string, not a number
    const wrongInput = (): Promise<number> => h.run(chain, 3, ctx);
    // @ts-expect-error the last step gives a number, not a string
    const wrongOutput = (): Promise<string> => h.run(chain, 'x', ctx);
    void wrongInput;
    void wrongOutput;
    const out: number = await h.run(
      [
        append('a', ''),
        length('b'),
      ],
      'ab',
      ctx,
    );
    expect(out).toBe(2);
  });

  it('ctx.harness.run inside a step takes an array too', async () => {
    const outer = runCode<ContextData, string, string>({
      id: 'outer',
      execute: async (input: string, ctx: Context) =>
        ctx.harness.run(
          [
            append('inner-a', 'A'),
            append('inner-b', 'B'),
          ],
          input,
          ctx,
        ),
    });
    expect(await runOn(outer, '>')).toBe('>AB');
  });

  it('an agentGraph given as an array runs as one sequence per turn', async () => {
    const seen: string[] = [];
    const record = (id: string): Step<ContextData, string, string> =>
      runCode<ContextData, string, string>({
        id,
        execute: async (input) => {
          seen.push(id);
          return input;
        },
      });
    const h = new AgentHarness({
      name: 'graph-array',
      params: {},
      agentGraph: [
        record('g1'),
        record('g2'),
      ],
    });
    await h.execute('hello');
    await h.getAgentResponse();
    expect(seen).toEqual([
      'g1',
      'g2',
    ]);
  });

  it('collects tools from every step of an array', () => {
    const tool = makeTestTool();
    const withTool = callModel<ContextData, string, string>({
      id: 'with-tool',
      model: 'test-model',
      tools: [
        tool,
      ],
    });
    const names = collectAllTools(
      toStep([
        append('plain', ''),
        withTool,
      ]),
    ).map((collected) => collected.name);
    expect(names).toContain(tool.name);
  });

  it('spawn and withContext take an array as their child', async () => {
    const spawned = spawn<ContextData, string, string>({
      id: 'spawned',
      child: [
        append('s1', '1'),
        append('s2', '2'),
      ],
    });
    expect(spawned.child.kind).toBe('sequence');
    expect(await runOn(spawned, 'x')).toBe('x12');

    const provided = withContext<ContextData, string, string>({
      id: 'provided',
      context: [],
      child: [
        append('w1', 'a'),
        append('w2', 'b'),
      ],
    });
    expect(provided.child.kind).toBe('sequence');
  });

  it('each inParallel path may be an array', async () => {
    const parallel = inParallel<ContextData, string, string>({
      id: 'paths',
      mode: 'all',
      paths: () => [
        [
          append('p1a', 'a'),
          append('p1b', 'b'),
        ],
        append('p2', 'c'),
      ],
      merge: (results) => results.join('|'),
    });
    expect(await runOn(parallel, 'x')).toBe('xab|xc');
  });

  it('a conditional route may pick an array', async () => {
    const routed = conditional<ContextData, string, string>({
      id: 'routed',
      route: () => [
        append('r1', '1'),
        append('r2', '2'),
      ],
    });
    expect(await runOn(routed, 'x')).toBe('x12');
  });
});

describe('array type checks', () => {
  // These run no step: each call sits in a function that is never invoked, so
  // only the compiler sees it.
  it('rejects a lookalike {kind, id} element (run, ctx.harness.run, spawn, withContext, agentGraph)', () => {
    const h = harness();
    const ctx = h.createContext();
    const bogus = (): unknown => {
      // @ts-expect-error a {kind, id} object is not a step
      void h.run(
        [
          length('n'),
          {
            kind: 'runCode',
            id: 'bogus',
          },
        ],
        'hi',
        ctx,
      );
      void runCode<ContextData, string, unknown>({
        id: 'inner',
        execute: async (input: string, c: Context) =>
          // @ts-expect-error a {kind, id} object is not a step
          c.harness.run(
            [
              append('a', ''),
              {
                kind: 'runCode',
                id: 'bogus',
              },
            ],
            input,
            c,
          ),
      });
      void spawn<ContextData, string, string>({
        id: 's',
        child: [
          append('a', ''),
          // @ts-expect-error a {kind, id} object is not a step
          {
            kind: 'runCode',
            id: 'bogus',
          },
        ],
      });
      void withContext<ContextData, string, string>({
        id: 'w',
        context: [],
        child: [
          append('a', ''),
          // @ts-expect-error a {kind, id} object is not a step
          {
            kind: 'runCode',
            id: 'bogus',
          },
        ],
      });
      return new AgentHarness({
        name: 'g',
        params: {},
        agentGraph: [
          append('a', ''),
          // @ts-expect-error a {kind, id} object is not a step
          {
            kind: 'runCode',
            id: 'bogus',
          },
        ],
      });
    };
    expect(typeof bogus).toBe('function');
  });

  it('rejects an array whose adjacent steps do not link', () => {
    const h = harness();
    const ctx = h.createContext();
    const mismatched = (): unknown => {
      // @ts-expect-error length outputs a number; append takes a string
      void h.run(
        [
          length('n'),
          append('a', ''),
        ],
        'hi',
        ctx,
      );
      const chain = [
        length('n'),
        append('a', ''),
      ] as const;
      // @ts-expect-error the same check holds for an `as const` tuple
      void h.run(chain, 'hi', ctx);
      const inner = runCode<ContextData, string, string>({
        id: 'inner',
        execute: async (input: string, c: Context) =>
          // @ts-expect-error length outputs a number; append takes a string
          c.harness.run(
            [
              length('n'),
              append('a', ''),
            ],
            input,
            c,
          ),
      });
      void inner;
      return new AgentHarness({
        name: 'g',
        params: {},
        // @ts-expect-error an agentGraph must output a string; length outputs a number
        agentGraph: [
          append('a', ''),
          length('n'),
        ],
      });
    };
    expect(typeof mismatched).toBe('function');
  });

  it('checks a builder array against its explicit input and output types', () => {
    const wrong = (): unknown => {
      void spawn<ContextData, string, string>({
        id: 's',
        // @ts-expect-error the last step outputs a number, not a string
        child: [
          append('a', ''),
          length('n'),
        ],
      });
      return withContext<ContextData, number, string>({
        id: 'w',
        context: [],
        child: [
          // @ts-expect-error the first step takes a string, not a number
          append('a', ''),
          append('b', ''),
        ],
      });
    };
    expect(typeof wrong).toBe('function');
  });

  it('detachedSpawn takes an array: rejects a broken one and runs a good one in sequence', async () => {
    const h = harness();
    const ctx = h.createContext();
    const broken = (): unknown => {
      // @ts-expect-error a {kind, id} object is not a step
      void h.detachedSpawn(
        [
          append('a', ''),
          {
            kind: 'runCode',
            id: 'bogus',
          },
        ],
        'x',
        ctx,
      );
      // @ts-expect-error length outputs a number; append takes a string
      return h.detachedSpawn(
        [
          length('n'),
          append('a', ''),
        ],
        'x',
        ctx,
      );
    };
    expect(typeof broken).toBe('function');
    const handle: DetachedHandle<number> = h.detachedSpawn(
      [
        append('d1', '-1'),
        length('d2'),
      ],
      'x',
      ctx,
    );
    expect(await handle.await()).toBe('x-1'.length);
  });

  it('ctx.harness.detachedSpawn takes an array too', async () => {
    const outer = runCode<ContextData, string, string>({
      id: 'outer',
      execute: async (input: string, ctx: Context) => {
        const handle = ctx.harness.detachedSpawn(
          [
            append('c1', 'A'),
            append('c2', 'B'),
          ],
          input,
          ctx,
        );
        return handle.await();
      },
    });
    expect(await runOn(outer, '>')).toBe('>AB');
  });

  it('accepts a homogeneous array variable and a Steps value passed through a generic', async () => {
    const h = harness();
    const list: Step<ContextData, string, string>[] = [
      append('h1', '1'),
      append('h2', '2'),
    ];
    const out: string = await h.run(list, 'x', h.createContext());
    expect(out).toBe('x12');
    const viaGeneric: number = await runSteps(
      h,
      [
        append('g1', '!'),
        length('g2'),
      ],
      'ab',
    );
    expect(viaGeneric).toBe(3);
    const viaSpawn = spawn<ContextData, string, string>({
      id: 'from-list',
      child: list,
    });
    expect(await runOn(viaSpawn, 'y')).toBe('y12');
    const mixed: number = await h.run(
      [
        append('m1', ''),
        length('m2'),
        toText('m3'),
        length('m4'),
      ],
      'abc',
      h.createContext(),
    );
    expect(mixed).toBe(1);
  });
});

describe('toStep copies and checks the array', () => {
  it('keeps a frozen copy, so changing the array after building changes nothing', async () => {
    const list: Step<ContextData, string, string>[] = [
      append('c1', '1'),
      append('c2', '2'),
    ];
    const built = toStep(list);
    list.push(append('c3', '3'));
    list[0] = append('swapped', '?');
    expect(built.id).toBe('c1 > c2');
    expect(stepChildren(frameworkCast<Step>(built)).map((child) => child.id)).toEqual([
      'c1',
      'c2',
    ]);
    expect(Object.isFrozen(stepChildren(frameworkCast<Step>(built)))).toBe(true);
    expect(await runOn(built, 'x')).toBe('x12');
  });

  it('rejects a nested array with INVALID_STEP_IN_ARRAY (arrays are not flattened)', () => {
    const nested = frameworkCast<Steps<ContextData, string, string>>([
      append('a', ''),
      [
        append('b', ''),
        append('c', ''),
      ],
    ]);
    expect(configErrorCode(() => toStep(nested))).toBe('INVALID_STEP_IN_ARRAY');
  });

  it('rejects null, a non-object, an unknown kind and a missing id with INVALID_STEP_IN_ARRAY', () => {
    const bad: ReadonlyArray<unknown> = [
      null,
      'step',
      {
        kind: 'notAKind',
        id: 'x',
      },
      {
        kind: 'runCode',
      },
    ];
    for (const element of bad) {
      const list = frameworkCast<Steps<ContextData, string, string>>([
        append('ok', ''),
        element,
      ]);
      expect(configErrorCode(() => toStep(list))).toBe('INVALID_STEP_IN_ARRAY');
    }
  });

  it('builders and harness.run surface INVALID_STEP_IN_ARRAY at build time', async () => {
    const nested = frameworkCast<Steps<ContextData, string, string>>([
      append('a', ''),
      [
        append('b', ''),
      ],
    ]);
    expect(
      configErrorCode(() =>
        spawn<ContextData, string, string>({
          id: 's',
          child: nested,
        }),
      ),
    ).toBe('INVALID_STEP_IN_ARRAY');
    const h = harness();
    let caught: unknown;
    try {
      await runSteps(h, nested, 'x');
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof NoeticConfigError ? caught.code : undefined).toBe(
      'INVALID_STEP_IN_ARRAY',
    );
  });
});

describe('condition clauses take arrays', () => {
  it('when and otherwise run an array in sequence', async () => {
    const isShort = async (input: string): Promise<boolean> => input.length < 3;
    const routed = conditional<ContextData, string, string>({
      id: 'clauses',
      route: semanticRoute<ContextData, string, string>(
        when(isShort, [
          append('w1', '+'),
          append('w2', '+'),
        ]),
        otherwise([
          append('o1', '-'),
          append('o2', '-'),
        ]),
      ),
    });
    expect(await runOn(routed, 'ab')).toBe('ab++');
    expect(await runOn(routed, 'abcd')).toBe('abcd--');
  });
});
