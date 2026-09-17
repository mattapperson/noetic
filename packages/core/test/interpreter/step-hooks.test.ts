import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type { AgentHooks, Step } from '@noetic-tools/types';
import { inParallel } from '../../src/builders/control-flow-builders';
import { loop } from '../../src/builders/loop-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { execute } from '../../src/interpreter/execute';
import { ContextImpl } from '../../src/runtime/context-impl';
import { StepLedger } from '../../src/runtime/durable/step-ledger';
import { until } from '../../src/until/predicates';

function harness(hooks: AgentHooks): AgentHarness {
  return new AgentHarness({
    name: 'hooks',
    params: {},
    hooks,
  });
}

function increment(id: string): Step<ContextData, number, number> {
  return {
    id,
    kind: 'runCode',
    execute: async (input) => input + 1,
  };
}

describe('step hooks', () => {
  it('awaits nested hooks and passes the actual result and context', async () => {
    const trace: string[] = [];
    const runtime = harness({
      async beforeStep(step, ctx) {
        await Promise.resolve();
        trace.push(`before:${step.id}`);
        ctx.state = true;
      },
      async afterStep(step, result, ctx) {
        await Promise.resolve();
        expect(ctx.state).toBe(true);
        trace.push(`after:${step.id}:${result}`);
      },
    });
    const ctx = runtime.createContext();
    assert(ctx instanceof ContextImpl);
    const root: Step<ContextData, number, number> = {
      id: 'root',
      kind: 'runCode',
      execute: async (input, current) => {
        expect(current.state).toBe(true);
        return runtime.run(increment('child'), input, current);
      },
    };
    expect(await runtime.run(root, 1, ctx)).toBe(2);
    expect(trace).toEqual([
      'before:root',
      'before:child',
      'after:child:2',
      'after:root:2',
    ]);
    expect(ctx.stepCount).toBe(2);
  });

  it('checkpoints state written by the after hook', async () => {
    const runtime = harness({
      async afterStep(_step, result, ctx) {
        ctx.state = result;
      },
    });
    const ctx = runtime.createContext();
    let saved: unknown;
    ctx.checkpoint = async () => {
      saved = ctx.state;
    };
    expect(await runtime.run(increment('save'), 2, ctx)).toBe(3);
    expect(saved).toBe(3);
    expect(ctx.state).toBe(3);
  });

  it('calls hooks for each loop pass and each parallel child context', async () => {
    const before: string[] = [];
    const after: string[] = [];
    const contexts = new Map<string, string>();
    const runtime = harness({
      async beforeStep(step, ctx) {
        before.push(step.id);
        contexts.set(step.id, ctx.id);
      },
      async afterStep(step) {
        after.push(step.id);
      },
    });
    const root = inParallel<ContextData, number, number>({
      id: 'parallel',
      mode: 'all',
      merge: (values) => values.reduce((a, b) => a + b),
      paths: () => [
        loop({
          id: 'repeat',
          steps: [
            increment('body'),
          ],
          until: until.maxSteps(2),
        }),
        increment('other'),
      ],
    });
    const ctx = runtime.createContext();
    assert(ctx instanceof ContextImpl);
    expect(await runtime.run(root, 0, ctx)).toBe(3);
    expect(before.filter((id) => id === 'body')).toHaveLength(2);
    expect(after.filter((id) => id === 'body')).toHaveLength(2);
    expect(before[0]).toBe('parallel');
    expect(after.at(-1)).toBe('parallel');
    expect(contexts.get('repeat')).not.toBe(contexts.get('other'));
    expect(ctx.stepCount).toBeGreaterThan(0);
  });

  it.each([
    'before',
    'body',
    'after',
  ] as const)('propagates %s failures and unwinds the frontier', async (phase) => {
    const failure = new Error(phase);
    const trace: string[] = [];
    const runtime = harness({
      async beforeStep() {
        trace.push('before');
        if (phase === 'before') {
          throw failure;
        }
      },
      async afterStep() {
        trace.push('after');
        if (phase === 'after') {
          throw failure;
        }
      },
    });
    const ctx = runtime.createContext();
    assert(ctx instanceof ContextImpl);
    const step: Step<ContextData, number, number> = {
      id: 'failed',
      kind: 'runCode',
      execute: async (input) => {
        trace.push('body');
        if (phase === 'body') {
          throw failure;
        }
        return input;
      },
    };
    await expect(runtime.run(step, 1, ctx)).rejects.toThrow(phase);
    expect(trace).toEqual(
      phase === 'before'
        ? [
            'before',
          ]
        : phase === 'body'
          ? [
              'before',
              'body',
            ]
          : [
              'before',
              'body',
              'after',
            ],
    );
    expect(ctx.serialiseFrontier()).toEqual([]);
    expect(ctx.stepCount).toBe(1);
  });

  it.each([
    false,
    true,
  ])('does not run a step cancelled before dispatch (in hook: %s)', async (inHook) => {
    const trace: string[] = [];
    const runtime = harness({
      async beforeStep(_step, ctx) {
        trace.push('before');
        ctx.abort('stop');
      },
      async afterStep() {
        trace.push('after');
      },
    });
    const ctx = runtime.createContext();
    assert(ctx instanceof ContextImpl);
    if (!inHook) {
      ctx.abort('stop');
    }
    await expect(runtime.run(increment('cancelled'), 0, ctx)).rejects.toMatchObject({
      noeticError: {
        kind: 'cancelled',
      },
    });
    expect(trace).toEqual(
      inHook
        ? [
            'before',
          ]
        : [],
    );
    expect(ctx.serialiseFrontier()).toEqual([]);
    expect(ctx.stepCount).toBe(inHook ? 1 : 0);
  });

  it('skips hooks and the body when replaying a completed step', async () => {
    const trace: string[] = [];
    const runtime = harness({
      async beforeStep() {
        trace.push('before');
      },
      async afterStep() {
        trace.push('after');
      },
    });
    const ledger = new StepLedger({
      executionId: 'replay',
      recovered: {
        entries: new Map([
          [
            '/saved#0',
            {
              path: '/saved#0',
              stepId: 'saved',
              kind: 'runCode',
              output: 42,
              completedAt: new Date().toISOString(),
            },
          ],
        ]),
        nextSeq: 1,
        oldestSeq: 0,
      },
    });
    const ctx = new ContextImpl({
      harness: runtime,
      ledger,
    });
    expect(await execute(increment('saved'), 0, ctx)).toBe(42);
    expect(trace).toEqual([]);
    expect(ctx.serialiseFrontier()).toEqual([]);
    expect(ctx.stepCount).toBe(1);
  });
});
