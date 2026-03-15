import { describe, it, expect } from 'bun:test';
import { executeBranch } from '../../src/interpreter/execute-branch';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { StepBranch, Step } from '../../src/types/step';
import type { Context } from '../../src/types/context';

const simpleExecute = async <I, O>(step: any, input: I, ctx: Context): Promise<O> => {
  if (step.kind === 'run') return step.execute(input, ctx);
  throw new Error(`Unsupported: ${step.kind}`);
};

describe('executeBranch', () => {
  it('route selects a step and executes it', async () => {
    const step: StepBranch<string, string> = {
      kind: 'branch', id: 'test',
      route: (input) => input === 'a'
        ? { kind: 'run', id: 'path-a', execute: async () => 'chose A' }
        : { kind: 'run', id: 'path-b', execute: async () => 'chose B' },
    };
    const ctx = new ContextImpl();
    expect(await executeBranch(step, 'a', ctx, simpleExecute)).toBe('chose A');
    expect(await executeBranch(step, 'b', ctx, simpleExecute)).toBe('chose B');
  });

  it('null route is no-op, returns input', async () => {
    const step: StepBranch<string, string> = {
      kind: 'branch', id: 'noop', route: () => null,
    };
    const result = await executeBranch(step, 'passthrough', new ContextImpl(), simpleExecute);
    expect(result).toBe('passthrough');
  });

  it('route function throws — error propagates unwrapped', async () => {
    const step: StepBranch<string, string> = {
      kind: 'branch', id: 'throw-test',
      route: () => { throw new Error('route exploded'); },
    };
    await expect(executeBranch(step, 'input', new ContextImpl(), simpleExecute)).rejects.toThrow('route exploded');
  });

  it('route receives context as second arg', async () => {
    let capturedCtx: Context | undefined;
    const step: StepBranch<string, string> = {
      kind: 'branch', id: 'ctx-test',
      route: (_input, ctx) => {
        capturedCtx = ctx;
        return { kind: 'run', id: 'inner', execute: async () => 'done' };
      },
    };
    const ctx = new ContextImpl();
    await executeBranch(step, 'test', ctx, simpleExecute);
    expect(capturedCtx).toBe(ctx);
  });

  it('selected step is executed with correct input', async () => {
    let receivedInput = '';
    const step: StepBranch<string, string> = {
      kind: 'branch', id: 'input-test',
      route: () => ({
        kind: 'run', id: 'inner',
        execute: async (input: string) => { receivedInput = input; return 'done'; },
      }),
    };
    await executeBranch(step, 'my-input', new ContextImpl(), simpleExecute);
    expect(receivedInput).toBe('my-input');
  });
});
