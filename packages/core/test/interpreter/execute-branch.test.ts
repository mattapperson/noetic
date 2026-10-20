import { describe, expect, it } from 'bun:test';
import type { ContextData } from '@noetic-tools/context';
import type { Context, StepConditional } from '@noetic-tools/types';
import { executeConditional } from '../../src/interpreter/execute-control';
import { ContextImpl } from '../../src/runtime/context-impl';
import { makeMockHarness, simpleExecute } from '../_helpers';

describe('executeConditional', () => {
  it('route selects a step and executes it', async () => {
    const step: StepConditional<ContextData, string, string> = {
      kind: 'conditional',
      id: 'test',
      route: (input) =>
        input === 'a'
          ? {
              kind: 'runCode',
              id: 'path-a',
              execute: async () => 'chose A',
            }
          : {
              kind: 'runCode',
              id: 'path-b',
              execute: async () => 'chose B',
            },
    };
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(await executeConditional(step, 'a', ctx, simpleExecute)).toBe('chose A');
    expect(await executeConditional(step, 'b', ctx, simpleExecute)).toBe('chose B');
  });

  it('null route is no-op, returns input', async () => {
    const step: StepConditional<ContextData, string, string> = {
      kind: 'conditional',
      id: 'noop',
      route: () => null,
    };
    const result = await executeConditional(
      step,
      'passthrough',
      new ContextImpl({
        harness: makeMockHarness(),
      }),
      simpleExecute,
    );
    expect(result).toBe('passthrough');
  });

  it('route function throws — error propagates unwrapped', async () => {
    const step: StepConditional<ContextData, string, string> = {
      kind: 'conditional',
      id: 'throw-test',
      route: () => {
        throw new Error('route exploded');
      },
    };
    await expect(
      executeConditional(
        step,
        'input',
        new ContextImpl({
          harness: makeMockHarness(),
        }),
        simpleExecute,
      ),
    ).rejects.toThrow('route exploded');
  });

  it('route receives context as second arg', async () => {
    let capturedCtx: Context | undefined;
    const step: StepConditional<ContextData, string, string> = {
      kind: 'conditional',
      id: 'ctx-test',
      route: (_input, ctx) => {
        capturedCtx = ctx;
        return {
          kind: 'runCode',
          id: 'inner',
          execute: async () => 'done',
        };
      },
    };
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    await executeConditional(step, 'test', ctx, simpleExecute);
    expect(capturedCtx).toBe(ctx);
  });

  it('async route function is awaited correctly', async () => {
    const step: StepConditional<ContextData, string, string> = {
      kind: 'conditional',
      id: 'async-test',
      route: async (input) => {
        await Promise.resolve();
        return input === 'async'
          ? {
              kind: 'runCode',
              id: 'async-path',
              execute: async () => 'async result',
            }
          : null;
      },
    };
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(await executeConditional(step, 'async', ctx, simpleExecute)).toBe('async result');
    expect(await executeConditional(step, 'other', ctx, simpleExecute)).toBe('other');
  });

  it('selected step is executed with correct input', async () => {
    let receivedInput = '';
    const step: StepConditional<ContextData, string, string> = {
      kind: 'conditional',
      id: 'input-test',
      route: () => ({
        kind: 'runCode',
        id: 'inner',
        execute: async (input: string) => {
          receivedInput = input;
          return 'done';
        },
      }),
    };
    await executeConditional(
      step,
      'my-input',
      new ContextImpl({
        harness: makeMockHarness(),
      }),
      simpleExecute,
    );
    expect(receivedInput).toBe('my-input');
  });
});
