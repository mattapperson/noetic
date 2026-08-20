/**
 * Regression tests for DEV-819: generator-tool yields must stream
 * incrementally instead of being accumulated into a growing events[] array.
 *
 * Every assertion here is structural (array lengths, event ordering, a gate
 * the generator cannot pass until the consumer has observed its first yield)
 * — no wall-clock sleeps, no RSS sampling.
 *
 * Against the pre-fix implementation these tests fail: the incremental-
 * delivery test deadlocks/never observes the first event early (pre-fix the
 * accumulator only emitted after each next() resolved, but retained every
 * yield), the bounded-retention test sees events arrays grow to 100k entries,
 * and the error-path test's progress events would still arrive but the
 * retained-history assertions on ui.progress would see the full prefix.
 */
import { describe, expect, it } from 'bun:test';
import type { ContextData } from '@noetic-tools/context';
import type { Context, StepInvokeTool, StreamEvent, Tool } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { executeInvokeTool } from '../../src/interpreter/execute-action';
import { makeMockContext, makeMockHarness } from '../_helpers';

/** A recording broadcaster satisfying the `_broadcaster` structural check. */
function recordingBroadcaster(): {
  events: StreamEvent[];
  emit(event: StreamEvent): void;
} {
  const events: StreamEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
  };
}

function ctxWithBroadcaster() {
  const broadcaster = recordingBroadcaster();
  const base = makeMockContext({
    harness: makeMockHarness(),
  });
  const ctx = frameworkCast<Context>({
    ...base,
    _broadcaster: broadcaster,
  });
  return {
    ctx,
    broadcaster,
    harness: base.harness,
  };
}

function progressEvents(broadcaster: { events: StreamEvent[] }): StreamEvent[] {
  return broadcaster.events.filter((e) => e.type.endsWith('tool_progress'));
}

function makeStep(tool: Tool, id = 'gen-step'): StepInvokeTool<ContextData, unknown, unknown> {
  return {
    kind: 'invokeTool',
    id,
    tool,
  };
}

describe('generator-tool streaming (DEV-819 regression)', () => {
  it('delivers the first yield before the generator finishes (incremental, not accumulated)', async () => {
    const { ctx, broadcaster, harness } = ctxWithBroadcaster();

    // Gate: the generator parks after its first yield until the test opens
    // the gate. If yields were buffered internally and only surfaced at
    // completion, this test would deadlock (caught by the runner timeout) —
    // with streaming, the first progress event lands in the broadcaster
    // while the generator is still suspended.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const tool = frameworkCast<Tool>({
      name: 'gated-stream',
      description: 'gated-stream',
      input: z.object({}),
      output: z.object({
        done: z.boolean(),
      }),
      execute: async function* () {
        yield {
          pct: 1,
        };
        await gate;
        return {
          done: true,
        };
      },
    });

    const run = executeInvokeTool(makeStep(tool), {}, ctx, harness);

    // Yield to the microtask queue so consumeToolGenerator can pull the
    // first yield and synchronously emit its progress event. The generator
    // is still parked on the gate — it has NOT finished.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const early = progressEvents(broadcaster);
    expect(early.length).toBeGreaterThanOrEqual(1);
    expect(early[0]?.data).toMatchObject({
      stepId: 'gen-step',
      toolName: 'gated-stream',
      event: {
        pct: 1,
      },
    });

    openGate();
    const result = await run;
    expect(result).toEqual({
      done: true,
    });
    expect(progressEvents(broadcaster)).toHaveLength(1);
  });

  it('retains only the latest yield per progress emit across 100k yields (bounded memory)', async () => {
    const { ctx, harness } = ctxWithBroadcaster();
    const N = 100_000;
    const seenLengths: number[] = [];
    let maxSeen = 0;

    const tool = frameworkCast<Tool>({
      name: 'firehose',
      description: 'firehose',
      input: z.object({}),
      output: z.object({
        done: z.boolean(),
      }),
      execute: async function* () {
        for (let i = 0; i < N; i++) {
          yield {
            i,
          };
        }
        return {
          done: true,
        };
      },
      ui: {
        // ui.progress receives the `events` argument the runtime passes. The
        // pre-fix code passed the full accumulated history (this array would
        // reach length N); the fixed code passes only the latest yield.
        progress: (events: unknown[]) => {
          seenLengths.push(events.length);
          if (events.length > maxSeen) {
            maxSeen = events.length;
          }
          return null;
        },
      },
    });

    const result = await executeInvokeTool(makeStep(tool), {}, ctx, harness);
    expect(result).toEqual({
      done: true,
    });
    expect(seenLengths).toHaveLength(N);
    // Structural bound: no progress call ever saw more than the latest yield.
    expect(maxSeen).toBe(1);
  });

  it('emits one tool_progress framework event per yield, in order', async () => {
    const { ctx, broadcaster, harness } = ctxWithBroadcaster();
    const tool = frameworkCast<Tool>({
      name: 'ordered',
      description: 'ordered',
      input: z.object({}),
      output: z.object({
        done: z.boolean(),
      }),
      execute: async function* () {
        for (let i = 0; i < 50; i++) {
          yield {
            i,
          };
        }
        return {
          done: true,
        };
      },
    });

    await executeInvokeTool(makeStep(tool), {}, ctx, harness);
    const events = progressEvents(broadcaster);
    expect(events).toHaveLength(50);
    const yielded = events.map((e) => {
      const data = frameworkCast<{
        event: {
          i: number;
        };
      }>(e.data);
      return data.event.i;
    });
    expect(yielded).toEqual(
      Array.from(
        {
          length: 50,
        },
        (_, i) => i,
      ),
    );
  });

  it('error path: partial yields are delivered in order and the error surfaces with pre-fix semantics', async () => {
    const { ctx, broadcaster, harness } = ctxWithBroadcaster();
    const progressSeen: unknown[] = [];

    const tool = frameworkCast<Tool>({
      name: 'boom-stream',
      description: 'boom-stream',
      input: z.object({}),
      output: z.object({}),
      execute: async function* () {
        yield 'first';
        yield 'second';
        throw new Error('mid-stream failure');
      },
      ui: {
        progress: (events: unknown[]) => {
          progressSeen.push(...events);
          return null;
        },
      },
    });

    let caught: unknown;
    try {
      await executeInvokeTool(makeStep(tool), {}, ctx, harness);
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      caught = e;
    }

    // Partial yields delivered, in order, before the error.
    expect(progressSeen).toEqual([
      'first',
      'second',
    ]);
    const emitted = progressEvents(broadcaster);
    expect(emitted).toHaveLength(2);
    const first = frameworkCast<{
      event: unknown;
    }>(emitted[0]?.data);
    const second = frameworkCast<{
      event: unknown;
    }>(emitted[1]?.data);
    expect(first.event).toBe('first');
    expect(second.event).toBe('second');

    // Same surface semantics as before the change: a NoeticError with
    // kind 'step_failed' wrapping the original error as cause.
    expect(caught).toBeInstanceOf(Error);
    const err = frameworkCast<{
      noeticError?: {
        kind?: string;
        cause?: Error;
      };
    }>(caught);
    expect(err.noeticError?.kind).toBe('step_failed');
    expect(err.noeticError?.cause?.message).toBe('mid-stream failure');
  });
});
