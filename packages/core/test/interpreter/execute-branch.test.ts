import { describe, expect, it } from 'bun:test';
import { executeBranch } from '../../src/interpreter/execute-control';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { Context } from '../../src/types/context';
import type { ContextMemory } from '../../src/types/memory';
import type { StepBranch } from '../../src/types/step';
import { makeMockHarness, simpleExecute } from '../_helpers';

describe('executeBranch', () => {
  it('route selects a step and executes it', async () => {
    const step: StepBranch<ContextMemory, string, string> = {
      kind: 'branch',
      id: 'test',
      route: (input) =>
        input === 'a'
          ? {
              kind: 'run',
              id: 'path-a',
              execute: async () => 'chose A',
            }
          : {
              kind: 'run',
              id: 'path-b',
              execute: async () => 'chose B',
            },
    };
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(await executeBranch(step, 'a', ctx, simpleExecute)).toBe('chose A');
    expect(await executeBranch(step, 'b', ctx, simpleExecute)).toBe('chose B');
  });

  it('null route is no-op, returns input', async () => {
    const step: StepBranch<ContextMemory, string, string> = {
      kind: 'branch',
      id: 'noop',
      route: () => null,
    };
    const result = await executeBranch(
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
    const step: StepBranch<ContextMemory, string, string> = {
      kind: 'branch',
      id: 'throw-test',
      route: () => {
        throw new Error('route exploded');
      },
    };
    await expect(
      executeBranch(
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
    const step: StepBranch<ContextMemory, string, string> = {
      kind: 'branch',
      id: 'ctx-test',
      route: (_input, ctx) => {
        capturedCtx = ctx;
        return {
          kind: 'run',
          id: 'inner',
          execute: async () => 'done',
        };
      },
    };
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    await executeBranch(step, 'test', ctx, simpleExecute);
    expect(capturedCtx).toBe(ctx);
  });

  it('async route function is awaited correctly', async () => {
    const step: StepBranch<ContextMemory, string, string> = {
      kind: 'branch',
      id: 'async-test',
      route: async (input) => {
        await Promise.resolve();
        return input === 'async'
          ? {
              kind: 'run',
              id: 'async-path',
              execute: async () => 'async result',
            }
          : null;
      },
    };
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(await executeBranch(step, 'async', ctx, simpleExecute)).toBe('async result');
    expect(await executeBranch(step, 'other', ctx, simpleExecute)).toBe('other');
  });

  it('selected step is executed with correct input', async () => {
    let receivedInput = '';
    const step: StepBranch<ContextMemory, string, string> = {
      kind: 'branch',
      id: 'input-test',
      route: () => ({
        kind: 'run',
        id: 'inner',
        execute: async (input: string) => {
          receivedInput = input;
          return 'done';
        },
      }),
    };
    await executeBranch(
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
