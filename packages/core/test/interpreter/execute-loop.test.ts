import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
import { loop } from '../../src/builders/loop-builder';
import { isNoeticError, NoeticErrorImpl } from '../../src/errors/noetic-error';
import { executeLoop } from '../../src/interpreter/execute-loop';
import { ChannelStore } from '../../src/runtime/channel-store';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { Snapshot } from '../../src/types/step';
import { until } from '../../src/until/predicates';
import { makeMockHarness, simpleExecute } from '../_helpers';

describe('executeLoop', () => {
  it('repeats body until predicate fires', async () => {
    let count = 0;
    const loopStep = loop<number, number>({
      id: 'test-loop',
      steps: [
        {
          kind: 'run',
          id: 'inc',
          execute: async (input: number) => {
            count++;
            return input + 1;
          },
        },
      ],
      until: until.maxSteps(3),
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const result = await executeLoop(loopStep, 0, ctx, simpleExecute);
    expect(count).toBe(3);
    expect(result).toBe(3); // 0+1=1, 1+1=2, 2+1=3
  });

  it('uses prepareNext to transform input between iterations', async () => {
    const inputs: string[] = [];
    const loopStep = loop<string, string>({
      id: 'prep-loop',
      steps: [
        {
          kind: 'run',
          id: 'echo',
          execute: async (input: string) => {
            inputs.push(input);
            return `result-${input}`;
          },
        },
      ],
      until: until.maxSteps(3),
      prepareNext: (output) => output.toUpperCase(),
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    await executeLoop(loopStep, 'first', ctx, simpleExecute);
    expect(inputs[0]).toBe('first');
    expect(inputs[1]).toBe('RESULT-FIRST');
    expect(inputs[2]).toBe('RESULT-RESULT-FIRST');
  });

  it('onError retry re-runs same iteration', async () => {
    let attempts = 0;
    const loopStep = loop<string, string>({
      id: 'retry-loop',
      steps: [
        {
          kind: 'run',
          id: 'flaky',
          execute: async (_input: string) => {
            attempts++;
            if (attempts <= 2) {
              throw new NoeticErrorImpl({
                kind: 'step_failed',
                stepId: 'flaky',
                cause: new Error('flaky'),
                retriesExhausted: false,
              });
            }
            return 'success';
          },
        },
      ],
      until: until.maxSteps(1),
      onError: () => 'retry',
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const result = await executeLoop(loopStep, 'go', ctx, simpleExecute);
    expect(result).toBe('success');
    expect(attempts).toBe(3); // 2 failures + 1 success
  });

  it('onError skip uses last successful output', async () => {
    let callCount = 0;
    const loopStep = loop<number, number>({
      id: 'skip-loop',
      steps: [
        {
          kind: 'run',
          id: 'sometimes-fail',
          execute: async (input: number) => {
            callCount++;
            if (callCount === 2) {
              throw new NoeticErrorImpl({
                kind: 'step_failed',
                stepId: 'sometimes-fail',
                cause: new Error('oops'),
                retriesExhausted: false,
              });
            }
            return input + 1;
          },
        },
      ],
      until: until.maxSteps(3),
      onError: () => 'skip',
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const result = await executeLoop(loopStep, 0, ctx, simpleExecute);
    // call 1: 0→1 (stepCount=1), call 2: error (skip, stepCount stays 1, output=1),
    // call 3: 1→2 (stepCount=2), call 4: 2→3 (stepCount=3, maxSteps fires)
    expect(result).toBe(3);
  });

  it('onError abort propagates error', async () => {
    const loopStep = loop<string, string>({
      id: 'abort-loop',
      steps: [
        {
          kind: 'run',
          id: 'fail',
          execute: async () => {
            throw new NoeticErrorImpl({
              kind: 'step_failed',
              stepId: 'fail',
              cause: new Error('boom'),
              retriesExhausted: false,
            });
          },
        },
      ],
      until: until.maxSteps(5),
      onError: () => 'abort',
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    try {
      await executeLoop(loopStep, 'go', ctx, simpleExecute);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
    }
  });

  it('predicate throw treated as stop', async () => {
    let count = 0;
    const loopStep = loop<number, number>({
      id: 'pred-throw-loop',
      steps: [
        {
          kind: 'run',
          id: 'inc',
          execute: async (input: number) => {
            count++;
            return input + 1;
          },
        },
      ],
      until: () => {
        throw new Error('predicate boom');
      },
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const result = await executeLoop(loopStep, 0, ctx, simpleExecute);
    expect(count).toBe(1); // runs once, predicate throws, stops
    expect(result).toBe(1);
  });

  it('snapshot population is correct', async () => {
    let capturedSnapshot: Snapshot | null = null;
    const loopStep = loop<string, string>({
      id: 'snap-loop',
      steps: [
        {
          kind: 'run',
          id: 'echo',
          execute: async (input: string) => `output-${input}`,
        },
      ],
      until: (snap) => {
        capturedSnapshot = snap;
        return {
          stop: snap.stepCount >= 1,
        };
      },
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    await executeLoop(loopStep, 'test', ctx, simpleExecute);

    // capturedSnapshot is assigned inside the `until` callback, so TS cannot narrow
    // the outer `let` binding. We assert non-null then access via a typed local.
    assert(capturedSnapshot !== null);
    const snap: Snapshot = capturedSnapshot;
    expect(snap.stepCount).toBe(1);
    expect(snap.lastOutput).toBe('output-test');
    expect(snap.lastText).toBe('output-test');
    expect(snap.history).toHaveLength(1);
    expect(snap.depth).toBe(0);
  });

  it('enforces maxIterations ceiling', async () => {
    const loopStep = loop<number, number>({
      id: 'ceiling-loop',
      steps: [
        {
          kind: 'run',
          id: 'inc',
          execute: async (input: number) => input + 1,
        },
      ],
      until: () => ({
        stop: false,
      }), // never stops
      maxIterations: 5,
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    try {
      await executeLoop(loopStep, 0, ctx, simpleExecute);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      const oe = e.noeticError;
      assert(oe.kind === 'step_failed');
      expect(oe.cause.message).toContain('maximum iterations');
    }
  });

  it('default maxIterations is 1000', async () => {
    let count = 0;
    const loopStep = loop<number, number>({
      id: 'default-ceiling-loop',
      steps: [
        {
          kind: 'run',
          id: 'inc',
          execute: async (input: number) => {
            count++;
            return input + 1;
          },
        },
      ],
      until: () => ({
        stop: false,
      }), // never stops
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    try {
      await executeLoop(loopStep, 0, ctx, simpleExecute);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(count).toBe(1e3);
    }
  });

  it('retry counts against maxIterations ceiling', async () => {
    let attempts = 0;
    const loopStep = loop<string, string>({
      id: 'retry-ceiling-loop',
      steps: [
        {
          kind: 'run',
          id: 'always-fail',
          execute: async () => {
            attempts++;
            throw new NoeticErrorImpl({
              kind: 'step_failed',
              stepId: 'always-fail',
              cause: new Error('always fails'),
              retriesExhausted: false,
            });
          },
        },
      ],
      until: until.maxSteps(100),
      maxIterations: 10,
      onError: () => 'retry',
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    try {
      await executeLoop(loopStep, 'go', ctx, simpleExecute);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(attempts).toBe(10); // capped by maxIterations
    }
  });

  it('aborts mid-loop when context is aborted', async () => {
    let count = 0;
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const loopStep = loop<number, number>({
      id: 'abort-mid-loop',
      steps: [
        {
          kind: 'run',
          id: 'inc',
          execute: async (input: number) => {
            count++;
            if (count === 2) {
              ctx.abort('stop now');
            }
            return input + 1;
          },
        },
      ],
      until: until.maxSteps(10),
    });

    try {
      await executeLoop(loopStep, 0, ctx, simpleExecute);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      const oe = e.noeticError;
      expect(oe.kind).toBe('cancelled');
      expect(count).toBe(2);
    }
  });

  it('rejects invalid maxIterations (NaN)', async () => {
    const loopStep = loop<number, number>({
      id: 'nan-loop',
      steps: [
        {
          kind: 'run',
          id: 'inc',
          execute: async (input: number) => input + 1,
        },
      ],
      until: until.maxSteps(5),
      maxIterations: Number.NaN,
    });
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    try {
      await executeLoop(loopStep, 0, ctx, simpleExecute);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      const oe = e.noeticError;
      assert(oe.kind === 'step_failed');
      expect(oe.cause.message).toContain('Invalid maxIterations');
    }
  });

  it('rejects invalid maxIterations (0)', async () => {
    const loopStep = loop<number, number>({
      id: 'zero-loop',
      steps: [
        {
          kind: 'run',
          id: 'inc',
          execute: async (input: number) => input + 1,
        },
      ],
      until: until.maxSteps(5),
      maxIterations: 0,
    });
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    try {
      await executeLoop(loopStep, 0, ctx, simpleExecute);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      const oe = e.noeticError;
      assert(oe.kind === 'step_failed');
      expect(oe.cause.message).toContain('Invalid maxIterations');
    }
  });

  it('trims history to maxHistorySize', async () => {
    let capturedHistory: unknown[] = [];
    const loopStep = loop<number, number>({
      id: 'history-loop',
      steps: [
        {
          kind: 'run',
          id: 'inc',
          execute: async (input: number) => input + 1,
        },
      ],
      until: (snap) => {
        capturedHistory = snap.history;
        return {
          stop: snap.stepCount >= 10,
        };
      },
      maxHistorySize: 3,
    });
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    await executeLoop(loopStep, 0, ctx, simpleExecute);
    // History should only contain the last 3 items
    expect(capturedHistory).toHaveLength(3);
    expect(capturedHistory).toEqual([
      8,
      9,
      10,
    ]);
  });

  it('onError skip on first iteration (no previous output) continues', async () => {
    let callCount = 0;
    const loopStep = loop<string, string>({
      id: 'skip-first-loop',
      steps: [
        {
          kind: 'run',
          id: 'fail-then-ok',
          execute: async (_input: string) => {
            callCount++;
            if (callCount === 1) {
              throw new NoeticErrorImpl({
                kind: 'step_failed',
                stepId: 'fail-then-ok',
                cause: new Error('first fail'),
                retriesExhausted: false,
              });
            }
            return 'success';
          },
        },
      ],
      // On first error with no previous output: skip → continue (stepCount stays 0).
      // Second call succeeds: stepCount increments to 1, satisfying maxSteps(1).
      until: until.maxSteps(1),
      onError: () => 'skip',
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const result = await executeLoop(loopStep, 'go', ctx, simpleExecute);
    expect(result).toBe('success');
    expect(callCount).toBe(2);
  });

  it('negative maxIterations throws validation error', async () => {
    const loopStep = loop<number, number>({
      id: 'neg-loop',
      steps: [
        {
          kind: 'run',
          id: 'inc',
          execute: async (input: number) => input + 1,
        },
      ],
      until: until.maxSteps(5),
      maxIterations: -1,
    });
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    try {
      await executeLoop(loopStep, 0, ctx, simpleExecute);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      const oe = e.noeticError;
      assert(oe.kind === 'step_failed');
      expect(oe.cause.message).toContain('Invalid maxIterations');
    }
  });

  it('uses verified predicate with feedback', async () => {
    let iteration = 0;
    const feedbacks: (string | undefined)[] = [];

    const loopStep = loop<string, string>({
      id: 'verify-loop',
      steps: [
        {
          kind: 'run',
          id: 'attempt',
          execute: async (_input: string) => {
            iteration++;
            return iteration >= 3 ? 'correct' : 'wrong';
          },
        },
      ],
      until: until.verified(async (output) => {
        if (output === 'correct') {
          return {
            pass: true,
          };
        }
        return {
          pass: false,
          feedback: 'Not correct yet',
        };
      }),
      prepareNext: (_output, verdict) => {
        feedbacks.push(verdict.feedback);
        return verdict.feedback ?? 'continue';
      },
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const result = await executeLoop(loopStep, 'start', ctx, simpleExecute);
    expect(result).toBe('correct');
    expect(iteration).toBe(3);
    expect(feedbacks[0]).toBe('Not correct yet');
  });

  it('executes multiple body steps sequentially', async () => {
    const order: string[] = [];
    const loopStep = loop<number, number>({
      id: 'multi-step-loop',
      steps: [
        {
          kind: 'run',
          id: 'double',
          execute: async (input: number) => {
            order.push('double');
            return input * 2;
          },
        },
        {
          kind: 'run',
          id: 'add-one',
          execute: async (input: number) => {
            order.push('add-one');
            return input + 1;
          },
        },
      ],
      until: until.maxSteps(2),
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    // Iteration 1: 1 → double → 2 → add-one → 3
    // Iteration 2: 3 → double → 6 → add-one → 7
    const result = await executeLoop(loopStep, 1, ctx, simpleExecute);
    expect(result).toBe(7);
    expect(order).toEqual([
      'double',
      'add-one',
      'double',
      'add-one',
    ]);
  });
});

describe('executeLoop inbox channel', () => {
  const inbox = channel('inbox', {
    schema: z.string(),
    mode: 'queue',
  });

  function makeInboxCtx(): {
    ctx: ContextImpl;
    channelStore: ChannelStore;
  } {
    const channelStore = new ChannelStore();
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
      channelStore,
    });
    return {
      ctx,
      channelStore,
    };
  }

  it('continues when inbox has a message after until says stop', async () => {
    const { ctx, channelStore } = makeInboxCtx();

    let callCount = 0;
    const loopStep = loop<number, number>({
      id: 'inbox-continue-loop',
      steps: [
        {
          kind: 'run',
          id: 'inc',
          execute: async (input: number) => {
            callCount++;
            return input + 1;
          },
        },
      ],
      until: until.maxSteps(1),
      inbox,
    });

    // Pre-load one message so the loop continues after first stop
    channelStore.send(inbox, 'wake up');

    const result = await executeLoop(loopStep, 0, ctx, simpleExecute);
    // First iteration: 0+1=1 (stop, but inbox has message → continue)
    // Second iteration: 1+1=2 (stop, inbox empty → truly stop)
    expect(callCount).toBe(2);
    expect(result).toBe(2);
  });

  it('stops when inbox is empty and until says stop', async () => {
    const { ctx } = makeInboxCtx();

    let callCount = 0;
    const loopStep = loop<number, number>({
      id: 'inbox-empty-loop',
      steps: [
        {
          kind: 'run',
          id: 'inc',
          execute: async (input: number) => {
            callCount++;
            return input + 1;
          },
        },
      ],
      until: until.maxSteps(1),
      inbox,
    });

    // No messages in inbox
    const result = await executeLoop(loopStep, 0, ctx, simpleExecute);
    expect(callCount).toBe(1);
    expect(result).toBe(1);
  });

  it('parks with parkTimeout and wakes on message', async () => {
    const { ctx, channelStore } = makeInboxCtx();

    let callCount = 0;
    const loopStep = loop<number, number>({
      id: 'inbox-park-loop',
      steps: [
        {
          kind: 'run',
          id: 'inc',
          execute: async (input: number) => {
            callCount++;
            return input + 1;
          },
        },
      ],
      until: until.maxSteps(1),
      inbox,
      parkTimeout: 2e3,
    });

    // Send a message after a short delay so the park recv picks it up
    setTimeout(() => {
      channelStore.send(inbox, 'delayed wake');
    }, 20);

    const result = await executeLoop(loopStep, 0, ctx, simpleExecute);
    expect(callCount).toBe(2);
    expect(result).toBe(2);
  });

  it('stops after parkTimeout expires with no message', async () => {
    const { ctx } = makeInboxCtx();

    let callCount = 0;
    const loopStep = loop<number, number>({
      id: 'inbox-timeout-loop',
      steps: [
        {
          kind: 'run',
          id: 'inc',
          execute: async (input: number) => {
            callCount++;
            return input + 1;
          },
        },
      ],
      until: until.maxSteps(1),
      inbox,
      parkTimeout: 50,
    });

    // No messages — should timeout and stop
    const result = await executeLoop(loopStep, 0, ctx, simpleExecute);
    expect(callCount).toBe(1);
    expect(result).toBe(1);
  });

  it('developer message appears in ctx.itemLog when inbox delivers', async () => {
    const { ctx, channelStore } = makeInboxCtx();

    const loopStep = loop<number, number>({
      id: 'inbox-log-loop',
      steps: [
        {
          kind: 'run',
          id: 'inc',
          execute: async (input: number) => input + 1,
        },
      ],
      until: until.maxSteps(1),
      inbox,
    });

    channelStore.send(inbox, 'hello from sub-agent');

    await executeLoop(loopStep, 0, ctx, simpleExecute);

    const devMessages = ctx.itemLog.items.filter(
      (item) => item.type === 'message' && item.role === 'developer',
    );
    expect(devMessages).toHaveLength(1);
    assert(devMessages[0].type === 'message');
    expect(devMessages[0].content[0]).toEqual({
      type: 'input_text',
      text: 'hello from sub-agent',
    });
  });
});
