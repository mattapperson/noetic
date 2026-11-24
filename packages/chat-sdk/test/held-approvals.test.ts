// Chat approvals through the harness's approval seam: the request still goes out
// on the approval channel, and the call is held in the harness rather than in the
// tool. See Noetic spec 08 § Held tool calls.

import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { ApproveToolCallParams, ExternalChannel } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
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

  test('holds with no deadline when the timeout is infinite', async () => {
    const { params } = approverParams(1e6, 'call-7');
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
  /** A harness that records `resolve` calls and can refuse them; its channel is closed. */
  function harness(refuse: boolean): {
    harness: HeldApprovalHarness;
    resolved: unknown[];
  } {
    const resolved: unknown[] = [];
    return {
      resolved,
      harness: frameworkCast<HeldApprovalHarness>({
        resolve: async (scope: unknown, answer: unknown) => {
          if (refuse) {
            throw new Error('no call with this id is held');
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
    const h = harness(false);
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
          callId: 'call-7',
          action: 'deny',
          guidance: 'wrong channel',
        },
      },
    ]);
  });

  test('maps an approval to allow', async () => {
    const h = harness(false);
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

  test('falls back to the channel when the harness holds no such call', async () => {
    const h = harness(true);
    // The channel is closed, as for a stale button: nothing was waiting.
    expect(
      await answerApproval({
        harness: h.harness,
        decision: {
          requestId: 'call-7',
          approved: true,
        },
      }),
    ).toBe(false);
  });
});

describe("fromAiSdkTool with approval: 'harness'", () => {
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
    const tool = fromAiSdkTool('deleteMessage', aiTool, {
      approval: 'harness',
    });
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

  test("by default the tool gates itself and is not marked for the harness's seam", () => {
    const tool = fromAiSdkTool('deleteMessage', aiTool);
    assert(tool.needsApproval !== true);
  });
});
