import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { ChannelHandle, ExternalChannel } from '@noetic-tools/types';
import { z } from 'zod';
import { chatTools, fromAiSdkTool } from '../src/ai-tools';
import type { ApprovalDecision, ApprovalRequest } from '../src/approvals';
import {
  APPROVAL_SCOPE,
  ApprovalRequestSchema,
  approvalDecisions,
  approvalRequests,
  resolveApproval,
} from '../src/approvals';

function aiTool(overrides: {
  description?: string;
  inputSchema?: unknown;
  needsApproval?: unknown;
  execute?: (input: unknown, options: unknown) => unknown;
}) {
  return {
    description: overrides.description,
    inputSchema: overrides.inputSchema,
    needsApproval: overrides.needsApproval,
    execute: overrides.execute ?? (async (input: unknown) => input),
  };
}

/**
 * Stand-in for the harness/ctx pair a gated tool sees: `send` records the
 * approval request, `recv` serves the scripted decisions in order (the tool
 * filters by requestId, so foreign decisions exercise the re-park loop).
 */
function approvalToolCtx(decisions: ApprovalDecision[]) {
  const requests: ApprovalRequest[] = [];
  const pending = [
    ...decisions,
  ];
  const toolCtx = {
    ctx: {
      threadId: 'thread-1',
    },
    harness: {
      send: (
        channel: {
          name: string;
        },
        value: unknown,
      ) => {
        expect(channel.name).toBe(approvalRequests.name);
        requests.push(ApprovalRequestSchema.parse(value));
        return Promise.resolve();
      },
      recv: (channel: { name: string }) => {
        expect(channel.name).toBe(approvalDecisions.name);
        const next = pending.shift();
        assert(next, 'tool recv-ed more decisions than scripted');
        return Promise.resolve(next);
      },
    },
  };
  return {
    toolCtx,
    requests,
  };
}

/** Resolves with an approval for the first request once one is recorded. */
async function approveOnceRequested(requests: ApprovalRequest[]): Promise<ApprovalDecision> {
  while (requests.length === 0) {
    await new Promise((r) => setTimeout(r, 0));
  }
  return {
    requestId: requests[0].requestId,
    approved: true,
  };
}

describe('fromAiSdkTool', () => {
  test('preserves the zod input schema and description, delegates execute', async () => {
    const schema = z.object({
      threadId: z.string(),
    });
    const calls: unknown[] = [];
    const tool = fromAiSdkTool(
      'fetchMessages',
      aiTool({
        description: 'Fetch messages',
        inputSchema: schema,
        execute: async (input) => {
          calls.push(input);
          return {
            ok: true,
          };
        },
      }),
    );

    expect(tool.name).toBe('fetchMessages');
    expect(tool.description).toBe('Fetch messages');
    expect(tool.input).toBe(schema);
    expect(tool.needsApproval).toBe(false);

    const result = await tool.execute(
      {
        threadId: 't1',
      },
      {
        ctx: {},
        harness: {},
      },
    );
    expect(result).toEqual({
      ok: true,
    });
    expect(calls).toEqual([
      {
        threadId: 't1',
      },
    ]);
  });

  test('inherits the vendor needsApproval default instead of ungating it', () => {
    expect(
      fromAiSdkTool(
        'del',
        aiTool({
          needsApproval: true,
        }),
      ).needsApproval,
    ).toBe(true);
    // A dynamic vendor predicate counts as gated.
    expect(
      fromAiSdkTool(
        'dyn',
        aiTool({
          needsApproval: () => true,
        }),
      ).needsApproval,
    ).toBe(true);
    expect(
      fromAiSdkTool(
        'read',
        aiTool({
          needsApproval: false,
        }),
      ).needsApproval,
    ).toBe(false);
    expect(fromAiSdkTool('bare', aiTool({})).needsApproval).toBe(false);
    // Explicit override beats the vendor flag in both directions.
    expect(
      fromAiSdkTool(
        'del',
        aiTool({
          needsApproval: true,
        }),
        {
          needsApproval: false,
        },
      ).needsApproval,
    ).toBe(false);
    expect(
      fromAiSdkTool(
        'read',
        aiTool({
          needsApproval: false,
        }),
        {
          needsApproval: true,
        },
      ).needsApproval,
    ).toBe(true);
  });

  test('falls back to z.unknown() when the tool has no zod schema', () => {
    const tool = fromAiSdkTool(
      'x',
      aiTool({
        inputSchema: undefined,
      }),
    );
    expect(
      tool.input.safeParse({
        anything: 1,
      }).success,
    ).toBe(true);
  });

  test('throws when the AI SDK tool has no execute', () => {
    expect(() =>
      fromAiSdkTool('broken', {
        description: 'no exec',
      }),
    ).toThrow(/no execute function/);
  });

  test('approved gated call sends a routed request then runs the tool', async () => {
    const { toolCtx, requests } = approvalToolCtx([]);
    const tool = fromAiSdkTool(
      'deleteMessage',
      aiTool({
        execute: async () => 'deleted',
      }),
      {
        needsApproval: true,
      },
    );

    const pendingResult = approveOnceRequested(requests);
    const ctxWithLiveRecv = {
      ...toolCtx,
      harness: {
        ...toolCtx.harness,
        recv: () => pendingResult,
      },
    };

    const result = await tool.execute(
      {
        messageId: 'm1',
      },
      ctxWithLiveRecv,
    );
    expect(result).toBe('deleted');
    expect(requests).toHaveLength(1);
    expect(requests[0].toolName).toBe('deleteMessage');
    expect(requests[0].args).toEqual({
      messageId: 'm1',
    });
    expect(requests[0].threadId).toBe('thread-1');
  });

  test("a foreign requestId's decision is skipped; the matching one settles the call", async () => {
    const tool = fromAiSdkTool(
      'deleteMessage',
      aiTool({
        execute: async () => 'deleted',
      }),
      {
        needsApproval: true,
      },
    );
    const { toolCtx, requests } = approvalToolCtx([
      {
        requestId: 'someone-else',
        approved: false,
      },
    ]);
    // Second recv resolves with OUR request's approval.
    let served = 0;
    const harness = {
      ...toolCtx.harness,
      recv: (channel: { name: string }) => {
        expect(channel.name).toBe(approvalDecisions.name);
        served++;
        if (served === 1) {
          return Promise.resolve({
            requestId: 'someone-else',
            approved: false,
          });
        }
        return Promise.resolve({
          requestId: requests[0].requestId,
          approved: true,
        });
      },
    };

    const result = await tool.execute(
      {},
      {
        ...toolCtx,
        harness,
      },
    );
    expect(result).toBe('deleted');
    expect(served).toBe(2);
  });

  test('rejected gated call throws with the reason and never runs the tool', async () => {
    let ran = false;
    const tool = fromAiSdkTool(
      'deleteMessage',
      aiTool({
        execute: async () => {
          ran = true;
          return 'deleted';
        },
      }),
      {
        needsApproval: true,
      },
    );
    const { toolCtx, requests } = approvalToolCtx([]);
    const harness = {
      ...toolCtx.harness,
      recv: async () => {
        while (requests.length === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
        return {
          requestId: requests[0].requestId,
          approved: false,
          reason: 'too risky',
        };
      },
    };

    await expect(
      tool.execute(
        {},
        {
          ...toolCtx,
          harness,
        },
      ),
    ).rejects.toThrow(/rejected by the user: too risky/);
    expect(ran).toBe(false);
  });
});

describe('chatTools', () => {
  test('wraps real createChatTools output, keeping vendor write-tool gating', async () => {
    const tools = await chatTools({
      chat: {},
    });

    expect(tools.length).toBeGreaterThan(0);
    const byName = new Map(
      tools.map((t) => [
        t.name,
        t,
      ]),
    );
    // Vendor default: write tools gated, read tools not.
    const deleteTool = byName.get('deleteMessage');
    assert(deleteTool);
    expect(deleteTool.needsApproval).toBe(true);
    const readTool = byName.get('fetchMessages');
    assert(readTool);
    expect(readTool.needsApproval).toBe(false);
  });

  test('requireApproval overrides the vendor default per tool', async () => {
    const tools = await chatTools({
      chat: {},
      requireApproval: {
        postMessage: false,
      },
    });
    const byName = new Map(
      tools.map((t) => [
        t.name,
        t,
      ]),
    );
    const postTool = byName.get('postMessage');
    assert(postTool);
    expect(postTool.needsApproval).toBe(false);
    // Unnamed write tools keep the vendor gate.
    const deleteTool = byName.get('deleteMessage');
    assert(deleteTool);
    expect(deleteTool.needsApproval).toBe(true);
  });
});

describe('resolveApproval', () => {
  function recordingHarness(closed: boolean) {
    const sent: Array<{
      channel: string;
      scope: string;
      value: unknown;
    }> = [];
    return {
      sent,
      harness: {
        getChannelHandle<T>(channel: ExternalChannel<T>, scope: string): ChannelHandle<T> {
          return {
            channel,
            closed,
            send: (value: T) => {
              if (closed) {
                throw new Error('closed');
              }
              sent.push({
                channel: channel.name,
                scope,
                value,
              });
            },
          };
        },
      },
    };
  }

  test('broadcasts the decision on the decisions channel under the approval scope', () => {
    const { harness, sent } = recordingHarness(false);
    const delivered = resolveApproval({
      harness,
      decision: {
        requestId: 'req-9',
        approved: true,
      },
    });

    expect(delivered).toBe(true);
    expect(sent).toEqual([
      {
        channel: 'chat-sdk:approval-decisions',
        scope: APPROVAL_SCOPE,
        value: {
          requestId: 'req-9',
          approved: true,
        },
      },
    ]);
  });

  test('returns false instead of throwing when the channel is closed', () => {
    const { harness, sent } = recordingHarness(true);
    const delivered = resolveApproval({
      harness,
      decision: {
        requestId: 'req-9',
        approved: true,
      },
    });
    expect(delivered).toBe(false);
    expect(sent).toEqual([]);
  });
});
