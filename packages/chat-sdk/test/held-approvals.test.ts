// Chat approvals through the harness's approval seam: the request still goes out
// on the approval channel, and the call is held in the harness rather than in the
// tool. See Noetic spec 08 § Held tool calls.

import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { ApproveToolCallParams, ExternalChannel } from '@noetic-tools/types';
import { frameworkCast, NoeticErrorImpl } from '@noetic-tools/types';
import { z } from 'zod';
import { fromAiSdkTool } from '../src/ai-tools';
import type { ApprovalRequest, HeldApprovalHarness } from '../src/approvals';
import { answerApproval, approvalRequests, chatApprover } from '../src/approvals';

interface Sent {
  channel: string;
  value: unknown;
}

/** Approver params whose harness records what is sent, with the clock at `now`. */
function approverParams(now: number, callId: string | undefined) {
  const sent: Sent[] = [];
  const params = frameworkCast<ApproveToolCallParams>({
    toolName: 'deleteMessage',
    toolArgs: {
      id: 'm1',
    },
    callId,
    ctx: {
      threadId: 'thread-9',
      harness: {
        config: {
          now: () => now,
        },
        send: async (channel: ExternalChannel<ApprovalRequest>, value: ApprovalRequest) => {
          sent.push({
            channel: channel.name,
            value,
          });
        },
      },
    },
  });
  return {
    params,
    sent,
  };
}

describe('chatApprover', () => {
  test('sends the request under the call id and holds the call until its deadline', async () => {
    const { params, sent } = approverParams(1e6, 'call-7');
    const decision = await chatApprover({
      timeout: 5e3,
    })(params);

    expect(decision).toEqual({
      action: 'hold',
      dueAt: 1e6 + 5e3,
    });
    expect(sent).toEqual([
      {
        channel: approvalRequests.name,
        value: {
          requestId: 'call-7',
          toolName: 'deleteMessage',
          args: {
            id: 'm1',
          },
          threadId: 'thread-9',
        },
      },
    ]);
  });

  test('holds with no deadline unless a timeout is set', async () => {
    const { params } = approverParams(1e6, 'call-7');
    expect(await chatApprover()(params)).toEqual({
      action: 'hold',
    });
    expect(
      await chatApprover({
        timeout: Number.POSITIVE_INFINITY,
      })(params),
    ).toEqual({
      action: 'hold',
    });
  });

  test('denies a call that has no id to ask about, and sends nothing', async () => {
    const { params, sent } = approverParams(1e6, undefined);
    const decision = await chatApprover()(params);
    expect(decision.action).toBe('deny');
    expect(sent).toEqual([]);
  });
});

describe('answerApproval', () => {
  /**
   * A harness holding `call-7`, that records the decisions passed to `execute`
   * and can fail them; its channel is closed.
   */
  function harness(
    fail?: 'refused' | 'storage',
    held: string[] = [
      'call-7',
    ],
  ): {
    harness: HeldApprovalHarness;
    resolved: unknown[];
  } {
    const resolved: unknown[] = [];
    return {
      resolved,
      harness: frameworkCast<HeldApprovalHarness>({
        pending: async () =>
          held.map((callId) => ({
            callId,
          })),
        execute: async (answer: unknown, scope: unknown) => {
          if (fail === 'refused') {
            throw new NoeticErrorImpl({
              kind: 'hold_refused',
              callId: 'call-7',
              reason: 'it was already answered differently',
            });
          }
          if (fail === 'storage') {
            throw new Error('storage is down');
          }
          resolved.push({
            scope,
            answer,
          });
        },
        getChannelHandle: () => ({
          closed: true,
          send: () => {},
        }),
      }),
    };
  }

  test('answers a call the harness holds, on the thread the request came from', async () => {
    const h = harness();
    const delivered = await answerApproval({
      harness: h.harness,
      threadId: 'thread-9',
      decision: {
        requestId: 'call-7',
        approved: false,
        reason: 'wrong channel',
      },
    });
    expect(delivered).toBe(true);
    expect(h.resolved).toEqual([
      {
        scope: {
          threadId: 'thread-9',
        },
        answer: {
          type: 'noetic:decision',
          callId: 'call-7',
          action: 'deny',
          guidance: 'wrong channel',
        },
      },
    ]);
  });

  test('maps an approval to allow', async () => {
    const h = harness();
    await answerApproval({
      harness: h.harness,
      decision: {
        requestId: 'call-7',
        approved: true,
      },
    });
    expect(h.resolved).toHaveLength(1);
    expect(h.resolved[0]).toMatchObject({
      answer: {
        action: 'allow',
      },
    });
  });

  const click = {
    requestId: 'call-7',
    approved: true,
  };

  test('falls back to the channel when the harness holds no such call', async () => {
    const h = harness(undefined, []);
    // The channel is closed, as for a stale button: nothing was waiting.
    expect(
      await answerApproval({
        harness: h.harness,
        decision: click,
      }),
    ).toBe(false);
    // The harness was not handed a decision for a call it does not hold.
    expect(h.resolved).toEqual([]);
  });

  test('is false when someone else answered first', async () => {
    const h = harness('refused');
    expect(
      await answerApproval({
        harness: h.harness,
        decision: click,
      }),
    ).toBe(false);
  });

  test('throws when the harness fails for another reason: the click was not delivered', async () => {
    const h = harness('storage');
    expect(
      answerApproval({
        harness: h.harness,
        decision: click,
      }),
    ).rejects.toThrow('storage is down');
  });

  test('is false for a stale click though the channel is open: sent is not taken', async () => {
    const sent: unknown[] = [];
    // A real harness's decision channel stays open for its whole life.
    const open = frameworkCast<HeldApprovalHarness>({
      pending: async () => [],
      execute: async () => expect.unreachable('the harness holds no such call'),
      getChannelHandle: () => ({
        closed: false,
        send: (value: unknown) => {
          sent.push(value);
        },
      }),
    });
    expect(
      await answerApproval({
        harness: open,
        decision: click,
      }),
    ).toBe(false);
    expect(sent).toEqual([]);
  });

  test('does not hand a decision to a harness that cannot list held calls', async () => {
    const executed: unknown[] = [];
    // Its `execute` would take the decision for a message and start a turn.
    const plain = frameworkCast<HeldApprovalHarness>({
      execute: async (input: unknown) => {
        executed.push(input);
      },
      getChannelHandle: () => ({
        closed: true,
        send: () => {},
      }),
    });
    expect(
      await answerApproval({
        harness: plain,
        decision: click,
      }),
    ).toBe(false);
    expect(executed).toEqual([]);
  });
});

describe('fromAiSdkTool gated through the harness', () => {
  const aiTool = {
    description: 'Delete a message.',
    inputSchema: z.object({
      id: z.string(),
    }),
    needsApproval: true,
    execute: async (input: unknown) => ({
      deleted: input,
    }),
  };

  test('marks the tool needsApproval and runs it without gating inside the tool', async () => {
    // The default: no option needed.
    const tool = fromAiSdkTool('deleteMessage', aiTool);
    expect(tool.needsApproval).toBe(true);
    // No harness on the context: an in-tool gate would have thrown reaching for it.
    const result = await tool.execute(
      {
        id: 'm1',
      },
      {},
    );
    expect(result).toEqual({
      deleted: {
        id: 'm1',
      },
    });
  });

  test('refuses approvalTimeout, which the harness would not apply', () => {
    expect(() =>
      fromAiSdkTool('deleteMessage', aiTool, {
        approvalTimeout: 1e3,
      }),
    ).toThrow('chatApprover({ timeout })');
    // With the tool gating itself, the timeout is its own.
    expect(() =>
      fromAiSdkTool('deleteMessage', aiTool, {
        approval: 'channel',
        approvalTimeout: 1e3,
      }),
    ).not.toThrow();
  });

  test("with approval: 'channel' the tool gates itself and is not marked for the seam", () => {
    const tool = fromAiSdkTool('deleteMessage', aiTool, {
      approval: 'channel',
    });
    assert(tool.needsApproval !== true);
  });
});
