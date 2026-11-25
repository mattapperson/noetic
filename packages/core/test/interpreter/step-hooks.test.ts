// AgentHooks.beforeStep / afterStep run around every step the interpreter executes (#95).
// See specs/08-runtime § Step hooks.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { AgentHooks, Context, ContextData, Step } from '@noetic-tools/types';
import { isNoeticError, NoeticErrorImpl } from '@noetic-tools/types';
import { runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';

//#region Fixtures

function harnessWith(hooks: AgentHooks, storage?: StorageAdapter): AgentHarness {
  return new AgentHarness({
    name: 'hooks',
    params: {},
    hooks,
    ...(storage
      ? {
          environment: {
            storage: {
              adapter: storage,
            },
          },
        }
      : {}),
  });
}

/** Hooks that note `before:<id>` and `after:<id>=<result>` in order. */
function recorder(): {
  log: string[];
  contexts: Context[];
  hooks: AgentHooks;
} {
  const log: string[] = [];
  const contexts: Context[] = [];
  return {
    log,
    contexts,
    hooks: {
      beforeStep: async (step: Step, ctx: Context) => {
        log.push(`before:${step.id}`);
        contexts.push(ctx);
      },
      afterStep: async (step: Step, result: unknown) => {
        log.push(`after:${step.id}=${String(result)}`);
      },
    },
  };
}

function code(id: string, fn: (input: string) => Promise<string> | string, log?: string[]) {
  return runCode<ContextData, string, string>({
    id,
    execute: async (input) => {
      log?.push(`run:${id}`);
      return fn(input);
    },
  });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable('expected a failure'),
    (error: unknown) => error,
  );
}

//#endregion

describe('step hooks', () => {
  it('runs beforeStep, then the step, then afterStep with its output', async () => {
    const { log, contexts, hooks } = recorder();
    const harness = harnessWith(hooks);
    const ctx = harness.createContext();
    const out = await harness.run(
      code('upper', (input) => input.toUpperCase(), log),
      'hi',
      ctx,
    );
    expect(out).toBe('HI');
    expect(log).toEqual([
      'before:upper',
      'run:upper',
      'after:upper=HI',
    ]);
    // The hook sees the context the step runs on: the run's context.
    expect(contexts[0]?.id).toBe(ctx.id);
    expect(ctx.stepCount).toBeGreaterThan(0);
  });

  it('runs around nested steps, the parent enclosing its children', async () => {
    const { log, hooks } = recorder();
    const harness = harnessWith(hooks);
    const ctx = harness.createContext();
    await harness.run(
      [
        code('a', (input) => `${input}a`, log),
        code('b', (input) => `${input}b`, log),
      ],
      '',
      ctx,
    );
    expect(log.filter((entry) => !entry.startsWith('run:'))).toEqual([
      expect.stringMatching(/^before:/),
      'before:a',
      'after:a=a',
      'before:b',
      'after:b=ab',
      expect.stringMatching(/^after:.*=ab$/),
    ]);
  });

  it('does not run afterStep for a step that failed', async () => {
    const { log, hooks } = recorder();
    const harness = harnessWith(hooks);
    const error = await caught(
      harness.run(
        code('boom', () => {
          throw new Error('boom');
        }),
        'x',
        harness.createContext(),
      ),
    );
    assert(isNoeticError(error));
    expect(error.noeticError.kind).toBe('step_failed');
    expect(log).toEqual([
      'before:boom',
    ]);
  });

  it('does not run afterStep for a step that was cancelled', async () => {
    const { log, hooks } = recorder();
    const harness = harnessWith(hooks);
    const ctx = harness.createContext();
    const error = await caught(
      harness.run(
        runCode<ContextData, string, string>({
          id: 'slow',
          execute: async () => {
            await harness.cancel(ctx, 'stop');
            throw new NoeticErrorImpl({
              kind: 'cancelled',
              reason: 'stop',
            });
          },
        }),
        'x',
        ctx,
      ),
    );
    assert(isNoeticError(error));
    expect(error.noeticError.kind).toBe('cancelled');
    expect(log).toEqual([
      'before:slow',
    ]);
  });

  it('a beforeStep that throws fails the step before it runs, as step_failed with the hook error as cause', async () => {
    const log: string[] = [];
    const hookError = new Error('not allowed');
    const harness = harnessWith({
      beforeStep: async () => {
        throw hookError;
      },
    });
    const error = await caught(
      harness.run(
        code('guarded', (i) => i, log),
        'x',
        harness.createContext(),
      ),
    );
    assert(isNoeticError(error));
    assert(error.noeticError.kind === 'step_failed');
    expect(error.noeticError.stepId).toBe('guarded');
    expect(error.cause).toBe(hookError);
    expect(log).toEqual([]);
  });

  it('a hook that throws a non-Error keeps the thrown value as the wrapper’s cause', async () => {
    const thrown = {
      code: 'denied',
    };
    const harness = harnessWith({
      beforeStep: async () => {
        throw thrown;
      },
    });
    const error = await caught(
      harness.run(
        code('guarded', (i) => i),
        'x',
        harness.createContext(),
      ),
    );
    assert(isNoeticError(error));
    const wrapper = error.cause;
    assert(wrapper instanceof Error);
    expect(wrapper.cause).toBe(thrown);
  });

  it('a hook that throws a NoeticError fails the step with that error unchanged', async () => {
    const denied = new NoeticErrorImpl({
      kind: 'steering_denied',
      guidance: 'no',
    });
    const harness = harnessWith({
      beforeStep: async () => {
        throw denied;
      },
    });
    expect(
      await caught(
        harness.run(
          code('guarded', (i) => i),
          'x',
          harness.createContext(),
        ),
      ),
    ).toBe(denied);
  });

  it('an afterStep that throws fails the step, which is not recorded and runs again on resume', async () => {
    const storage = createInMemoryStorage();
    const log: string[] = [];
    let failAfter = true;
    const hooks: AgentHooks = {
      afterStep: async (step) => {
        if (step.id === 'work' && failAfter) {
          throw new Error('audit write failed');
        }
      },
    };
    const step = code('work', (input) => `${input}!`, log);
    const first = harnessWith(hooks, storage);
    const ctx = first.createContext();
    const error = await caught(first.run(step, 'x', ctx));
    assert(isNoeticError(error));
    expect(error.noeticError.kind).toBe('step_failed');

    failAfter = false;
    const next = harnessWith(hooks, storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(step, 'x', resumed)).toBe('x!');
    expect(log).toEqual([
      'run:work',
      'run:work',
    ]);
  });

  it('runs neither hook for a step replayed from the ledger', async () => {
    const storage = createInMemoryStorage();
    const runs: string[] = [];
    let hang = true;
    const tail = runCode<ContextData, string, string>({
      id: 'tail',
      execute: async (input) => {
        runs.push('run:tail');
        if (hang) {
          hang = false;
          throw new Error('host died');
        }
        return `${input}t`;
      },
    });
    const head = code('head', (input) => `${input}h`, runs);
    const firstLog = recorder();
    const first = harnessWith(firstLog.hooks, storage);
    const ctx = first.createContext();
    await caught(
      first.run(
        [
          head,
          tail,
        ],
        'x',
        ctx,
      ),
    );

    const secondLog = recorder();
    const next = harnessWith(secondLog.hooks, storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(
      await next.run(
        [
          head,
          tail,
        ],
        'x',
        resumed,
      ),
    ).toBe('xht');
    // head replayed: it did not run, and no hook ran for it.
    expect(runs).toEqual([
      'run:head',
      'run:tail',
      'run:tail',
    ]);
    expect(secondLog.log).not.toContain('before:head');
    expect(secondLog.log).toContain('before:tail');
    expect(secondLog.log).toContain('after:tail=xht');
  });

  it('runs no hooks when none are configured', async () => {
    const log: string[] = [];
    const harness = harnessWith({});
    expect(
      await harness.run(
        code('plain', (i) => i, log),
        'x',
        harness.createContext(),
      ),
    ).toBe('x');
    expect(log).toEqual([
      'run:plain',
    ]);
  });
});
