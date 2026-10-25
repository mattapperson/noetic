/**
 * Core enforces `needsApproval`: after the `beforeToolCall` layers allow a
 * call, the harness approver decides it. Covers both enforcement points — the
 * model-driven tool loop (refusal → error tool result) and `invokeTool`
 * (refusal → `steering_denied`) — plus the default without an approver (the
 * call runs, with a one-time warning) and the `tool.approval` span attribute.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import assert from 'node:assert';
import type {
  ApproveToolCallParams,
  Context,
  ContextLayer,
  LLMResponse,
  SteeringDecision,
  ToolApprover,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticError, SteeringAction } from '@noetic-tools/types';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
import { invokeTool } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { executeInvokeTool } from '../../src/interpreter/execute-action';
import { ToolAttr } from '../../src/observability/genai-attributes';
import { InMemoryExporter } from '../../src/observability/trace-exporter';
import { makeMessage } from '../_helpers';

//#region Fakes

type MockModelResponse = LLMResponse & {
  id: string;
  output: LLMResponse['items'];
  status?: string;
};

function usage(): LLMResponse['usage'] {
  return {
    inputTokens: 5,
    outputTokens: 2,
  };
}

/** Round 1 requests one `add` call; round 2 finishes with a message. */
class AddThenDoneClient {
  calls = 0;

  callModel(): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<MockModelResponse>;
  } {
    return {
      async *getFullResponsesStream() {},
      getResponse: async () => {
        this.calls += 1;
        if (this.calls === 1) {
          return frameworkCast<MockModelResponse>({
            id: 'resp-tool-call',
            status: 'completed',
            output: [
              {
                id: 'fc-1',
                status: 'completed',
                type: 'function_call',
                callId: 'call-1',
                name: 'add',
                arguments: JSON.stringify({
                  a: 2,
                  b: 3,
                }),
              },
            ],
            items: [],
            usage: usage(),
          });
        }
        return frameworkCast<MockModelResponse>({
          id: 'resp-final',
          status: 'completed',
          output: [
            {
              id: 'msg-final',
              status: 'completed',
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'done',
                },
              ],
            },
          ],
          items: [],
          usage: usage(),
        });
      },
    };
  }
}

interface Fixture {
  harness: AgentHarness<Record<string, never>>;
  exporter: InMemoryExporter;
  ctx: Context;
  approvals: ApproveToolCallParams[];
  runs: Array<{
    a: number;
    b: number;
  }>;
}

function fixture(approver?: (params: ApproveToolCallParams) => ReturnType<ToolApprover>): Fixture {
  const exporter = new InMemoryExporter();
  const approvals: ApproveToolCallParams[] = [];
  const harness = new AgentHarness({
    name: 'approval',
    params: {},
    traceExporter: exporter,
    approveToolCall: approver
      ? (params) => {
          approvals.push(params);
          return approver(params);
        }
      : undefined,
  });
  frameworkCast<{
    client: unknown;
  }>(harness).client = new AddThenDoneClient();
  return {
    harness,
    exporter,
    ctx: harness.createContext(),
    approvals,
    runs: [],
  };
}

function addTool(f: Fixture, needsApproval: boolean | undefined) {
  return tool({
    name: 'add',
    description: 'Add',
    input: z.object({
      a: z.number(),
      b: z.number(),
    }),
    output: z.object({
      sum: z.number(),
    }),
    needsApproval,
    execute: async (args) => {
      f.runs.push(args);
      return {
        sum: args.a + args.b,
      };
    },
  });
}

const allow = (): SteeringDecision => ({
  action: SteeringAction.Allow,
});

const deny = (guidance: string) => (): SteeringDecision => ({
  action: SteeringAction.Deny,
  guidance,
});

function denyLayer(guidance: string): ContextLayer {
  return frameworkCast<ContextLayer>({
    id: 'deny-all',
    slot: 0,
    scope: 'execution',
    hooks: {
      beforeToolCall: async () => ({
        decision: {
          action: SteeringAction.Deny,
          guidance,
        },
      }),
    },
  });
}

/** Run the model loop once and return the `add` tool's result text. */
async function modelCall(
  f: Fixture,
  needsApproval: boolean | undefined,
  layers?: ContextLayer[],
): Promise<string> {
  const response = await f.harness.callModel({
    model: 'test/model',
    items: [
      makeMessage('user', 'add'),
    ],
    tools: [
      addTool(f, needsApproval),
    ],
    ctx: f.ctx,
    layers,
  });
  const result = response.items.find((item) => item.type === 'function_call_output');
  assert(result && result.type === 'function_call_output');
  assert(typeof result.output === 'string');
  return result.output;
}

function invokeAdd(f: Fixture, needsApproval: boolean | undefined) {
  return invokeTool({
    id: 'add-step',
    tool: addTool(f, needsApproval),
  });
}

async function steeringDenial(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (e) {
    assert(isNoeticError(e));
    assert(e.noeticError.kind === 'steering_denied');
    return e.noeticError.guidance;
  }
  throw new Error('expected steering_denied');
}

function approvalAttr(f: Fixture): unknown {
  const [span] = f.exporter.getSpansByName('tool.call');
  assert(span);
  return span.attributes.get(ToolAttr.APPROVAL);
}

/** An approver that parks on a channel until the test sends the human's answer. */
function channelApprover() {
  const answers = channel('approval-answers', {
    schema: z.boolean(),
    mode: 'queue',
  });
  let markAsked: () => void = () => {};
  const asked = new Promise<void>((resolve) => {
    markAsked = resolve;
  });
  const approver = async ({ ctx }: ApproveToolCallParams): Promise<SteeringDecision> => {
    markAsked();
    const approved = await ctx.harness.recv(answers, ctx);
    return approved ? allow() : deny('the human said no')();
  };
  return {
    answers,
    asked,
    approver,
  };
}

let warnings: string[] = [];
let warnSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  warnings = [];
  warnSpy = spyOn(console, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
});

afterEach(() => {
  warnSpy?.mockRestore();
});

//#endregion

describe('model-requested calls', () => {
  it('an approved call runs, the approver sees validated args, and the span records it', async () => {
    const f = fixture(allow);

    const output = await modelCall(f, true);

    expect(output).toContain('5');
    expect(f.runs).toEqual([
      {
        a: 2,
        b: 3,
      },
    ]);
    expect(f.approvals).toHaveLength(1);
    const [request] = f.approvals;
    assert(request);
    expect(request.toolName).toBe('add');
    expect(request.toolArgs).toEqual({
      a: 2,
      b: 3,
    });
    expect(request.callId).toBe('call-1');
    expect(approvalAttr(f)).toBe('approved');
  });

  it('a denied call returns an error tool result and never runs', async () => {
    const f = fixture(deny('not today'));

    const output = await modelCall(f, true);

    expect(output).toBe('Tool call denied: not today');
    expect(f.runs).toEqual([]);
    expect(approvalAttr(f)).toBe('denied');
  });

  it('a guide decision redirects the call like a gating layer does', async () => {
    const f = fixture(() => ({
      action: SteeringAction.Guide,
      guidance: 'ask the user first',
    }));

    const output = await modelCall(f, true);

    expect(output).toBe('Tool call redirected: ask the user first');
    expect(f.runs).toEqual([]);
    expect(approvalAttr(f)).toBe('denied');
  });

  it('an async approver can park on a channel until a human answers', async () => {
    const { answers, asked, approver } = channelApprover();
    const f = fixture(approver);

    const pending = modelCall(f, true);
    await asked;
    expect(f.runs).toEqual([]);
    await f.harness.send(answers, true, f.ctx);

    expect(await pending).toContain('5');
    expect(f.runs).toHaveLength(1);
  });

  it('with no approver the call runs, warns once per tool name, and the span records it', async () => {
    const f = fixture();

    expect(await modelCall(f, true)).toContain('5');
    frameworkCast<{
      client: unknown;
    }>(f.harness).client = new AddThenDoneClient();
    expect(await modelCall(f, true)).toContain('5');

    expect(f.runs).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tool 'add' needs approval");
    expect(warnings[0]).toContain('approveToolCall');
    expect(approvalAttr(f)).toBe('none_configured');
  });

  it('a throwing approver fails closed', async () => {
    const f = fixture(() => {
      throw new Error('approval service down');
    });

    const output = await modelCall(f, true);

    expect(output).toContain("approval for tool 'add' failed: approval service down");
    expect(f.runs).toEqual([]);
    expect(approvalAttr(f)).toBe('denied');
  });

  it('a layer denial wins: the approver is never asked', async () => {
    const f = fixture(allow);

    const output = await modelCall(f, true, [
      denyLayer('blocked by policy'),
    ]);

    expect(output).toBe('Tool call denied: blocked by policy');
    expect(f.approvals).toEqual([]);
    expect(f.runs).toEqual([]);
    expect(approvalAttr(f)).toBeUndefined();
  });

  for (const needsApproval of [
    false,
    undefined,
  ]) {
    it(`needsApproval ${String(needsApproval)} runs without asking, even with no approver`, async () => {
      const f = fixture();

      const output = await modelCall(f, needsApproval);

      expect(output).toContain('5');
      expect(f.runs).toHaveLength(1);
      expect(warnings).toEqual([]);
      expect(approvalAttr(f)).toBeUndefined();
    });
  }
});

describe('invokeTool', () => {
  it('an approved call runs and the span records it', async () => {
    const f = fixture(allow);

    const result = await f.harness.run(
      invokeAdd(f, true),
      {
        a: 1,
        b: 2,
      },
      f.ctx,
    );

    expect(result).toEqual({
      sum: 3,
    });
    const [request] = f.approvals;
    assert(request);
    expect(request.callId).toBe('add-step');
    expect(request.toolArgs).toEqual({
      a: 1,
      b: 2,
    });
    expect(approvalAttr(f)).toBe('approved');
  });

  it('a denied call throws steering_denied and never runs', async () => {
    const f = fixture(deny('not today'));

    const guidance = await steeringDenial(
      f.harness.run(
        invokeAdd(f, true),
        {
          a: 1,
          b: 2,
        },
        f.ctx,
      ),
    );

    expect(guidance).toBe('not today');
    expect(f.runs).toEqual([]);
    expect(f.ctx.itemLog.items).toEqual([]);
    expect(approvalAttr(f)).toBe('denied');
  });

  it('an async approver can park on a channel until a human answers', async () => {
    const { answers, asked, approver } = channelApprover();
    const f = fixture(approver);

    const pending = f.harness.run(
      invokeAdd(f, true),
      {
        a: 1,
        b: 2,
      },
      f.ctx,
    );
    await asked;
    await f.harness.send(answers, false, f.ctx);

    expect(await steeringDenial(pending)).toBe('the human said no');
    expect(f.runs).toEqual([]);
  });

  it('with no approver the call runs, warns, and the span records it', async () => {
    const f = fixture();

    const result = await f.harness.run(
      invokeAdd(f, true),
      {
        a: 1,
        b: 2,
      },
      f.ctx,
    );

    expect(result).toEqual({
      sum: 3,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tool 'add' needs approval");
    expect(approvalAttr(f)).toBe('none_configured');
  });

  it('a throwing approver throws steering_denied', async () => {
    const f = fixture(async () => {
      throw new Error('approval service down');
    });

    const guidance = await steeringDenial(
      f.harness.run(
        invokeAdd(f, true),
        {
          a: 1,
          b: 2,
        },
        f.ctx,
      ),
    );

    expect(guidance).toContain('approval service down');
    expect(f.runs).toEqual([]);
  });

  it('a layer denial wins: the approver is never asked', async () => {
    const f = fixture(allow);

    const guidance = await steeringDenial(
      executeInvokeTool(
        invokeAdd(f, true),
        {
          a: 1,
          b: 2,
        },
        f.ctx,
        f.harness,
        [
          denyLayer('blocked by policy'),
        ],
      ),
    );

    expect(guidance).toBe('blocked by policy');
    expect(f.approvals).toEqual([]);
    expect(f.runs).toEqual([]);
  });

  for (const needsApproval of [
    false,
    undefined,
  ]) {
    it(`needsApproval ${String(needsApproval)} runs without asking, even with no approver`, async () => {
      const f = fixture();

      const result = await f.harness.run(
        invokeAdd(f, needsApproval),
        {
          a: 1,
          b: 2,
        },
        f.ctx,
      );

      expect(result).toEqual({
        sum: 3,
      });
      expect(warnings).toEqual([]);
      expect(approvalAttr(f)).toBeUndefined();
    });
  }
});
