import { describe, expect, it } from 'bun:test';
import type { Context, ContextData, Step, StepArray } from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import {
  AgentHarness,
  callModel,
  conditional,
  inParallel,
  runCode,
  spawn,
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
    expect(stepChildren(built).map((child) => child.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('refuses an empty array with EMPTY_STEP_ARRAY', () => {
    // The StepArray type already refuses `[]`; the runtime guard covers untyped callers.
    const empty = frameworkCast<StepArray>([]);
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
