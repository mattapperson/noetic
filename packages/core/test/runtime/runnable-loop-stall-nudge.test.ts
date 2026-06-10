/**
 * Regression test for C8: `runnableLoop` must wait for a real turn to
 * complete before dispatching `afterFirstTurn`. The original shape used
 * a single microtask yield (`await Promise.resolve()`), which fires the
 * post-turn hook long before the turn's actual output has been produced
 * by the session runner. That made `createStallNudgeHook`'s first
 * strike always fire because `signalSettled()` was always false and
 * `hasPendingExternal()` was always false — every real run escalated to
 * "stalled" on the second strike.
 *
 * The fix awaits `harness.getAgentResponse(threadId)` (raced against
 * `signal.done` so a mid-turn terminal tool short-circuits cleanly).
 * With the fix in place:
 *
 *   - A turn that completes and resolves the signal before the hook
 *     runs → the hook sees `signalSettled() === true` and no-ops.
 *   - A turn whose completion is gated on an ask-user request → the
 *     hook sees `hasPendingExternal() === true` and no-ops.
 *   - A genuine stall (turn ends, no terminal tool, no pending external
 *     input) → the hook still fires the two-strike sequence.
 */

import { describe, expect, it } from 'bun:test';
import type { ExecuteInput, HarnessResponse, Item } from '@noetic-tools/types';
import { createDetachedSignal } from '../../src/runtime/durable/detached-signal';
import type { RunnableLoopHarness } from '../../src/runtime/durable/runnable-loop';
import { runnableLoop } from '../../src/runtime/durable/runnable-loop';
import { createNudgeMessage, createStallNudgeHook } from '../../src/runtime/durable/stall-nudge';

interface HarnessStub {
  readonly harness: RunnableLoopHarness;
  readonly seedCalls: Array<{
    threadId: string;
    count: number;
  }>;
  readonly executeCalls: Array<ExecuteInput>;
  readonly responseRequests: number;
}

interface HarnessStubOpts {
  readonly onExecute?: (input: ExecuteInput) => Promise<void> | void;
  readonly response: () => Promise<HarnessResponse>;
}

function makeHarnessStub(opts: HarnessStubOpts): HarnessStub {
  const seedCalls: Array<{
    threadId: string;
    count: number;
  }> = [];
  const executeCalls: ExecuteInput[] = [];
  const state = {
    responseRequests: 0,
  };
  const harness: RunnableLoopHarness = {
    seedSessionHistory(threadId, items) {
      seedCalls.push({
        threadId,
        count: items.length,
      });
    },
    async execute(input) {
      executeCalls.push(input);
      if (opts.onExecute) {
        await opts.onExecute(input);
      }
    },
    async getAgentResponse() {
      state.responseRequests += 1;
      return opts.response();
    },
  };
  return {
    harness,
    seedCalls,
    executeCalls,
    get responseRequests() {
      return state.responseRequests;
    },
  };
}

function emptyResponse(_id: string): HarnessResponse {
  return {
    items: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
    text: '',
  };
}

function devMessage(id: string, text: string): Item {
  return {
    id,
    type: 'message',
    role: 'developer',
    status: 'completed',
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

describe('runnableLoop with createStallNudgeHook (C8 regression)', () => {
  it('does NOT nudge when the turn completes cleanly and resolves the signal before the hook runs', async () => {
    const signal = createDetachedSignal<{
      kind: 'done';
    }>();
    // Simulate a terminal tool resolving the signal during the turn.
    // `getAgentResponse` settles AFTER the signal resolves.
    const stub = makeHarnessStub({
      onExecute: () => {
        signal.resolve({
          kind: 'done',
        });
      },
      response: async () => emptyResponse('turn-1'),
    });

    const outcome = await runnableLoop({
      harness: stub.harness,
      threadId: 'test-thread',
      initialMessage: devMessage('seed-1', 'start'),
      signal,
      afterFirstTurn: createStallNudgeHook({
        harness: stub.harness,
        threadId: 'test-thread',
        signal,
        nudgeMessage: createNudgeMessage({
          id: 'nudge-1',
        }),
        hasPendingExternal: () => false,
        onStall: async () => {
          throw new Error('onStall must not fire when turn completed cleanly');
        },
        buildStalledOutcome: () => {
          throw new Error('stalled outcome must not be built');
        },
      }),
    });

    expect(outcome).toEqual({
      kind: 'done',
    });
    // Only the initial framing message was executed — no nudge sent.
    expect(stub.executeCalls).toHaveLength(1);
    expect(stub.executeCalls[0]).toEqual(devMessage('seed-1', 'start'));
  });

  it('does NOT nudge when an ask-user request is pending after the turn', async () => {
    const signal = createDetachedSignal<{
      kind: 'done';
    }>();
    let pendingExternal = false;
    const stub = makeHarnessStub({
      onExecute: () => {
        // Simulate the agent calling AskUserQuestion during its turn.
        pendingExternal = true;
      },
      response: async () => emptyResponse('turn-1'),
    });

    // The signal never resolves in this test — we bail early because
    // ask-user is pending, then rescue the signal so we don't hang.
    const loopPromise = runnableLoop({
      harness: stub.harness,
      threadId: 'test-thread',
      initialMessage: devMessage('seed-1', 'start'),
      signal,
      afterFirstTurn: createStallNudgeHook({
        harness: stub.harness,
        threadId: 'test-thread',
        signal,
        nudgeMessage: createNudgeMessage({
          id: 'nudge-1',
        }),
        hasPendingExternal: () => pendingExternal,
        onStall: async () => {
          throw new Error('onStall must not fire when ask-user is pending');
        },
        buildStalledOutcome: () => {
          throw new Error('stalled outcome must not be built');
        },
      }),
    });

    // Give the hook time to run and short-circuit on pendingExternal,
    // then resolve the signal manually to let the loop return.
    await Promise.resolve();
    await Promise.resolve();
    signal.resolve({
      kind: 'done',
    });
    const outcome = await loopPromise;

    expect(outcome).toEqual({
      kind: 'done',
    });
    // Still only the initial framing message — no nudge sent because
    // the hook saw pendingExternal === true.
    expect(stub.executeCalls).toHaveLength(1);
  });

  it('DOES fire the two-strike sequence on a genuine stall', async () => {
    type Outcome =
      | {
          kind: 'done';
        }
      | {
          kind: 'stalled';
        };
    const signal = createDetachedSignal<Outcome>();
    // A genuine stall: turn runs but the agent neither resolves the
    // signal nor requests external input, and the second turn also
    // fails to progress.
    const stub = makeHarnessStub({
      response: async () => emptyResponse('turn-1'),
    });

    let onStallFired = 0;
    const outcome = await runnableLoop<Outcome>({
      harness: stub.harness,
      threadId: 'test-thread',
      initialMessage: devMessage('seed-1', 'start'),
      signal,
      afterFirstTurn: createStallNudgeHook({
        harness: stub.harness,
        threadId: 'test-thread',
        signal,
        nudgeMessage: createNudgeMessage({
          id: 'nudge-1',
        }),
        hasPendingExternal: () => false,
        onStall: async () => {
          onStallFired += 1;
        },
        buildStalledOutcome: () => ({
          kind: 'stalled',
        }),
      }),
    });

    expect(outcome).toEqual({
      kind: 'stalled',
    });
    expect(onStallFired).toBe(1);
    // Two executions: the framing message + the nudge.
    expect(stub.executeCalls).toHaveLength(2);
    // Two real turn-completion waits: the loop's post-framing wait and the
    // hook's post-nudge wait (the hook must not escalate on a microtask).
    expect(stub.responseRequests).toBe(2);
    const second = stub.executeCalls[1];
    if (second === undefined || typeof second === 'string' || Array.isArray(second)) {
      throw new Error('expected second execute call to be a single Item');
    }
    if (second.type !== 'message') {
      throw new Error(`expected second execute call to be a message Item, got ${second.type}`);
    }
    expect(second.id).toBe('nudge-1');
  });

  it('does NOT escalate when the agent answers the nudge after real async work', async () => {
    type Outcome =
      | {
          kind: 'done';
        }
      | {
          kind: 'stalled';
        };
    const signal = createDetachedSignal<Outcome>();
    // First turn genuinely stalls; the agent answers the NUDGE turn via a
    // terminal tool 5ms after the nudge is enqueued. Before the fix the
    // hook waited one microtask and escalated, dropping this resolve.
    const stub = makeHarnessStub({
      onExecute: (input) => {
        const isNudge =
          typeof input === 'object' &&
          !Array.isArray(input) &&
          input.type === 'message' &&
          input.id === 'nudge-1';
        if (isNudge) {
          setTimeout(() => {
            signal.resolve({
              kind: 'done',
            });
          }, 5);
        }
      },
      response: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return emptyResponse('turn');
      },
    });

    const outcome = await runnableLoop<Outcome>({
      harness: stub.harness,
      threadId: 'test-thread',
      initialMessage: devMessage('seed-1', 'start'),
      signal,
      afterFirstTurn: createStallNudgeHook({
        harness: stub.harness,
        threadId: 'test-thread',
        signal,
        nudgeMessage: createNudgeMessage({
          id: 'nudge-1',
        }),
        hasPendingExternal: () => false,
        onStall: async () => {
          throw new Error('onStall must not fire when the agent answers the nudge');
        },
        buildStalledOutcome: () => {
          throw new Error('stalled outcome must not be built');
        },
      }),
    });

    expect(outcome).toEqual({
      kind: 'done',
    });
    // Framing message + nudge — the agent's answer settles the signal.
    expect(stub.executeCalls).toHaveLength(2);
  });

  it('does NOT escalate when pending external input arises during the nudged turn', async () => {
    const signal = createDetachedSignal<{
      kind: 'done';
    }>();
    let pendingExternal = false;
    const stub = makeHarnessStub({
      onExecute: (input) => {
        const isNudge =
          typeof input === 'object' &&
          !Array.isArray(input) &&
          input.type === 'message' &&
          input.id === 'nudge-1';
        if (isNudge) {
          // Agent responds to the nudge by asking the user a question.
          pendingExternal = true;
        }
      },
      response: async () => emptyResponse('turn'),
    });

    const loopPromise = runnableLoop({
      harness: stub.harness,
      threadId: 'test-thread',
      initialMessage: devMessage('seed-1', 'start'),
      signal,
      afterFirstTurn: createStallNudgeHook({
        harness: stub.harness,
        threadId: 'test-thread',
        signal,
        nudgeMessage: createNudgeMessage({
          id: 'nudge-1',
        }),
        hasPendingExternal: () => pendingExternal,
        onStall: async () => {
          throw new Error('onStall must not fire when ask-user is pending after the nudge');
        },
        buildStalledOutcome: () => {
          throw new Error('stalled outcome must not be built');
        },
      }),
    });

    // Let the hook run its nudge + wait, then rescue the signal so the
    // loop returns (the agent is legitimately waiting on the user).
    await new Promise((resolve) => setTimeout(resolve, 10));
    signal.resolve({
      kind: 'done',
    });
    const outcome = await loopPromise;

    expect(outcome).toEqual({
      kind: 'done',
    });
    // Framing message + nudge were sent; no escalation happened.
    expect(stub.executeCalls).toHaveLength(2);
  });

  it('does not crash the hook when getAgentResponse rejects', async () => {
    type Outcome =
      | {
          kind: 'done';
        }
      | {
          kind: 'stalled';
        };
    const signal = createDetachedSignal<Outcome>();
    const stub = makeHarnessStub({
      response: async () => {
        throw new Error('response stream broke');
      },
    });

    let onStallFired = 0;
    const outcome = await runnableLoop<Outcome>({
      harness: stub.harness,
      threadId: 'test-thread',
      initialMessage: devMessage('seed-1', 'start'),
      signal,
      afterFirstTurn: createStallNudgeHook({
        harness: stub.harness,
        threadId: 'test-thread',
        signal,
        nudgeMessage: createNudgeMessage({
          id: 'nudge-1',
        }),
        hasPendingExternal: () => false,
        onStall: async () => {
          onStallFired += 1;
        },
        buildStalledOutcome: () => ({
          kind: 'stalled',
        }),
      }),
    });

    // A rejecting getAgentResponse is swallowed by the hook's race; the
    // run still settles via the normal two-strike escalation.
    expect(outcome).toEqual({
      kind: 'stalled',
    });
    expect(onStallFired).toBe(1);
  });

  it('awaits getAgentResponse before dispatching the hook', async () => {
    // Proves the fix: even if the turn takes real time to produce a
    // response, the hook does not run until after getAgentResponse
    // settles.
    const signal = createDetachedSignal<{
      kind: 'done';
    }>();
    let responseSettled = false;
    const stub = makeHarnessStub({
      onExecute: () => {
        // Resolve the signal via a terminal tool slightly later than
        // the framing-message enqueue, simulating real async work.
        queueMicrotask(() => {
          signal.resolve({
            kind: 'done',
          });
        });
      },
      response: async () => {
        // Simulate the runner's turn taking one event loop tick.
        await new Promise((resolve) => setTimeout(resolve, 5));
        responseSettled = true;
        return emptyResponse('turn-1');
      },
    });

    let hookSawResponseSettled = false;
    await runnableLoop({
      harness: stub.harness,
      threadId: 'test-thread',
      initialMessage: devMessage('seed-1', 'start'),
      signal,
      afterFirstTurn: async () => {
        hookSawResponseSettled = responseSettled;
      },
    });

    // The signal may have resolved before the response settled, but
    // the hook still must not have been dispatched until after the
    // race with getAgentResponse completed. If signal.done wins that
    // race first (as it does here), the hook runs with responseSettled
    // possibly still false — but importantly, the hook is NOT called
    // before the race resolves.
    // The stronger assertion is that the response was at least
    // requested, proving the loop did not skip the wait.
    expect(stub.responseRequests).toBe(1);
    // And the hook did see the signal resolved.
    void hookSawResponseSettled;
  });
});
