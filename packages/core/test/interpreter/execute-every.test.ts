import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
import { every } from '../../src/builders/every';
import { isNoeticError, NoeticErrorImpl } from '../../src/errors/noetic-error';
import { execute } from '../../src/interpreter/execute';
import { executeEvery } from '../../src/interpreter/execute-every';
import { SpanImpl } from '../../src/observability/span-impl';
import { ChannelStore } from '../../src/runtime/channel-store';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { ContextMemory } from '../../src/types/memory';
import { makeMockHarness, simpleExecute, sleep } from '../_helpers';

interface CapturedEvent {
  name: string;
  attributes?: Record<string, string | number | boolean>;
}

function makeCapturingSpan(): {
  span: SpanImpl;
  events: ReadonlyArray<CapturedEvent>;
} {
  const span = new SpanImpl('every-test', null);
  return {
    span,
    events: span.events,
  };
}

describe('executeEvery', () => {
  it('paces 3 iterations at ms=50 in >= 100ms total', async () => {
    let count = 0;
    const everyStep = every<ContextMemory, number, number>({
      id: 'pacing-every',
      step: {
        kind: 'run',
        id: 'tick',
        execute: async (input: number) => {
          count++;
          if (count >= 3) {
            // Abort after the third iteration so the operator returns.
            ctx.abort('done');
          }
          return input;
        },
      },
      ms: 50,
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const start = Date.now();
    try {
      await executeEvery(everyStep, 0, ctx, simpleExecute);
      expect.unreachable('should have thrown cancelled');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('cancelled');
    }
    const elapsed = Date.now() - start;
    expect(count).toBe(3);
    // Iter 1 immediate, then park 50ms, iter 2, park 50ms, iter 3 → at least 100ms.
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it('wakeOn channel cuts park short — next iter starts within ~5ms of send', async () => {
    const wake = channel('wake', {
      schema: z.string(),
      mode: 'queue',
    });
    const channelStore = new ChannelStore();

    const iterTimestamps: number[] = [];
    let count = 0;

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
      channelStore,
    });

    const everyStep = every<ContextMemory, void, void>({
      id: 'wake-every',
      step: {
        kind: 'run',
        id: 'tick',
        execute: async () => {
          iterTimestamps.push(Date.now());
          count++;
          if (count >= 2) {
            ctx.abort('done');
          }
        },
      },
      ms: 5e3,
      wakeOn: wake,
    });

    // Schedule the wake send shortly after start so the first park
    // (5s) is interrupted.
    const sendTime = Date.now() + 30;
    setTimeout(() => {
      channelStore.send(wake, 'wake!');
    }, 30);

    try {
      await executeEvery(everyStep, undefined, ctx, simpleExecute);
      expect.unreachable('should have thrown cancelled');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('cancelled');
    }

    expect(count).toBe(2);
    // Second iteration should fire shortly after the wake send rather than
    // after the full 5s park.
    const secondIter = iterTimestamps[1];
    assert(secondIter !== undefined);
    const delta = secondIter - sendTime;
    // Generous bound — observed wake latency is dominated by the 5ms abort poll.
    expect(delta).toBeLessThan(50);
  });

  it("onError 'continue' (default) records span event and proceeds", async () => {
    const { span, events } = makeCapturingSpan();
    let count = 0;

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
      span,
    });

    const everyStep = every<ContextMemory, void, void>({
      id: 'continue-every',
      step: {
        kind: 'run',
        id: 'flaky',
        execute: async () => {
          count++;
          if (count === 1) {
            throw new Error('iteration 1 boom');
          }
          if (count >= 2) {
            ctx.abort('done');
          }
        },
      },
      ms: 10,
    });

    try {
      await executeEvery(everyStep, undefined, ctx, simpleExecute);
      expect.unreachable('should have thrown cancelled');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('cancelled');
    }

    expect(count).toBe(2);
    const errorEvents = events.filter((ev) => ev.name === 'every.iteration.error');
    expect(errorEvents).toHaveLength(1);
    const ev = errorEvents[0];
    assert(ev.attributes !== undefined);
    expect(ev.attributes.message).toBe('iteration 1 boom');
    expect(typeof ev.attributes.stack).toBe('string');
  });

  it("onError 'fail' propagates and operator terminates with that error", async () => {
    const failure = new Error('fatal boom');
    const everyStep = every<ContextMemory, void, void>({
      id: 'fail-every',
      step: {
        kind: 'run',
        id: 'fail',
        execute: async () => {
          throw failure;
        },
      },
      ms: 1e3,
      onError: 'fail',
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });

    let caught: unknown;
    try {
      await executeEvery(everyStep, undefined, ctx, simpleExecute);
      expect.unreachable('should have thrown');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(failure);
  });

  it('abort during long park returns control within ~50ms', async () => {
    let started = false;
    const everyStep = every<ContextMemory, void, void>({
      id: 'abort-park-every',
      step: {
        kind: 'run',
        id: 'mark',
        execute: async () => {
          started = true;
        },
      },
      // 5 seconds — far longer than the test should take if abort works.
      ms: 5e3,
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });

    // Trigger abort once the operator enters its first park.
    setTimeout(() => {
      ctx.abort('test abort');
    }, 25);

    const start = Date.now();
    let caught: unknown;
    try {
      await executeEvery(everyStep, undefined, ctx, simpleExecute);
      expect.unreachable('should have thrown cancelled');
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    expect(started).toBe(true);
    assert(isNoeticError(caught));
    expect(caught.noeticError.kind).toBe('cancelled');
    // Generous bound — the 5ms abort poll plus scheduling latency.
    expect(elapsed).toBeLessThan(200);
  });

  it('jitter clamps actual park duration within [ms - jitter, ms + jitter]', async () => {
    const ms = 40;
    const jitter = 20;
    const N = 5;
    const timestamps: number[] = [];
    let count = 0;

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });

    const everyStep = every<ContextMemory, void, void>({
      id: 'jitter-every',
      step: {
        kind: 'run',
        id: 'tick',
        execute: async () => {
          timestamps.push(Date.now());
          count++;
          if (count >= N) {
            ctx.abort('done');
          }
        },
      },
      ms,
      jitter,
    });

    try {
      await executeEvery(everyStep, undefined, ctx, simpleExecute);
      expect.unreachable('should have thrown cancelled');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('cancelled');
    }

    expect(timestamps.length).toBe(N);
    // Generous tolerance for scheduler/event-loop noise.
    const SCHEDULER_SLACK = 60;
    for (let i = 1; i < timestamps.length; i++) {
      const delta = timestamps[i] - timestamps[i - 1];
      // Lower bound: ms - jitter, but allow some drift downward for first-iter
      // alignment (timer can fire slightly early on some platforms).
      expect(delta).toBeGreaterThanOrEqual(Math.max(0, ms - jitter - 10));
      // Upper bound: ms + jitter + scheduler slack.
      expect(delta).toBeLessThanOrEqual(ms + jitter + SCHEDULER_SLACK);
    }
  });

  it('integrates with execute() dispatch via every kind', async () => {
    let count = 0;
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const everyStep = every<ContextMemory, void, void>({
      id: 'dispatch-every',
      step: {
        kind: 'run',
        id: 'tick',
        execute: async () => {
          count++;
          if (count >= 2) {
            ctx.abort('done');
          }
        },
      },
      ms: 10,
    });

    try {
      await execute(everyStep, undefined, ctx);
      expect.unreachable('should have thrown cancelled');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('cancelled');
    }
    expect(count).toBe(2);
  });

  it("onError 'continue' does not swallow cancelled errors", async () => {
    let calls = 0;
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });

    const everyStep = every<ContextMemory, void, void>({
      id: 'cancel-not-swallowed',
      step: {
        kind: 'run',
        id: 'cancellable',
        execute: async () => {
          calls++;
          // Abort and immediately throw a cancelled NoeticError, simulating
          // the body's own cancellation surfacing through.
          ctx.abort('user abort');
          throw new NoeticErrorImpl({
            kind: 'cancelled',
            reason: 'user abort',
          });
        },
      },
      ms: 1,
    });

    try {
      await executeEvery(everyStep, undefined, ctx, simpleExecute);
      expect.unreachable('should have thrown cancelled');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('cancelled');
    }
    expect(calls).toBe(1);
  });

  it('aborts before first iteration when ctx already cancelled', async () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    ctx.abort('preempted');

    let count = 0;
    const everyStep = every<ContextMemory, void, void>({
      id: 'pre-aborted-every',
      step: {
        kind: 'run',
        id: 'tick',
        execute: async () => {
          count++;
        },
      },
      ms: 5,
    });

    try {
      await executeEvery(everyStep, undefined, ctx, simpleExecute);
      expect.unreachable('should have thrown cancelled');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('cancelled');
    }
    expect(count).toBe(0);
  });

  it('park completes after ms when no wakeOn and not aborted', async () => {
    let count = 0;
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const everyStep = every<ContextMemory, void, void>({
      id: 'plain-park-every',
      step: {
        kind: 'run',
        id: 'tick',
        execute: async () => {
          count++;
          if (count >= 2) {
            ctx.abort('done');
          }
        },
      },
      ms: 30,
    });

    const start = Date.now();
    try {
      await executeEvery(everyStep, undefined, ctx, simpleExecute);
    } catch {
      // expected cancelled
    }
    const elapsed = Date.now() - start;
    expect(count).toBe(2);
    // At least one ~30ms park between the two iterations.
    expect(elapsed).toBeGreaterThanOrEqual(25);
  });

  it('does not run a second iteration once aborted', async () => {
    let count = 0;
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const everyStep = every<ContextMemory, void, void>({
      id: 'no-second-iter-every',
      step: {
        kind: 'run',
        id: 'tick',
        execute: async () => {
          count++;
          ctx.abort('done after first');
        },
      },
      ms: 10,
    });

    try {
      await executeEvery(everyStep, undefined, ctx, simpleExecute);
    } catch {
      // expected cancelled
    }
    // Give a small grace period to ensure no rogue iteration sneaks in.
    await sleep(50);
    expect(count).toBe(1);
  });

  it('wakeOn on a queue channel does not consume the message — body sees it', async () => {
    const wake = channel<string>('wake-queue', {
      schema: z.string(),
      mode: 'queue',
    });
    const channelStore = new ChannelStore();
    const observed: string[] = [];

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
      channelStore,
    });

    const everyStep = every<ContextMemory, void, void>({
      id: 'queue-wake',
      step: {
        kind: 'run',
        id: 'drain',
        execute: async (_input, c) => {
          while (true) {
            const v = c.tryRecv(wake);
            if (v === null) {
              break;
            }
            observed.push(v);
          }
          if (observed.length >= 2) {
            ctx.abort('done');
          }
        },
      },
      ms: 5_000,
      wakeOn: wake,
    });

    setTimeout(() => {
      channelStore.send(wake, 'first');
    }, 30);
    setTimeout(() => {
      channelStore.send(wake, 'second');
    }, 80);

    try {
      await executeEvery(everyStep, undefined, ctx, simpleExecute);
      expect.unreachable('should have thrown cancelled');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('cancelled');
    }

    expect(observed).toEqual([
      'first',
      'second',
    ]);
  });
});
