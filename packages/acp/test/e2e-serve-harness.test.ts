/**
 * The end-to-end proof the mock-based suite cannot give: a REAL `AgentHarness`
 * (real interpreter, real tool loop, real event bracket — only the model
 * client is faked) served through `toAcpAgent` over loopback and driven by
 * Noetic's own ACP client.
 *
 * This is what retires the mock-forced findings: the `failed`/`completed`
 * outcomes below come from core's own `tool_call_completed` events, the gate
 * runs inside core's real `beforeToolCall` pipeline, and the additive layer
 * injection is proven against a harness that HAS layers of its own.
 *
 * `@noetic-tools/core` is a devDependency of this package for exactly this
 * test; the src → src boundary (`acp` never imports `core`) is untouched.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import { AgentHarness, channel, tool } from '@noetic-tools/core';
import type { AcpSessionNotification, ContextLayer, LLMResponse, Step } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { openAcpConnection } from '../src/connection';
import { toAcpAgent } from '../src/serve';
import type { AcpServeOptions } from '../src/serve-types';
import { loopbackTransport } from '../src/transport-loopback';
import { MemoryFs, RecordingShell } from './_helpers';

//#region Fake model clients

type MockModelResponse = LLMResponse & {
  id: string;
  output: LLMResponse['items'];
  status?: string;
};

function finalMessageResponse(text: string): MockModelResponse {
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
            text,
          },
        ],
      },
    ],
    items: [],
    usage: {
      inputTokens: 5,
      outputTokens: 2,
    },
    cost: 0.001,
  });
}

/** Round 1 requests one tool call; round 2 finishes with a message. */
class ToolCallThenDoneClient {
  calls = 0;

  constructor(
    private readonly toolName: string,
    private readonly args: Record<string, unknown>,
  ) {}

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
                callId: 'call-e2e-1',
                name: this.toolName,
                arguments: JSON.stringify(this.args),
              },
            ],
            items: [],
            usage: {
              inputTokens: 5,
              outputTokens: 2,
            },
          });
        }
        return finalMessageResponse('all done');
      },
    };
  }
}

function installClient(harness: AgentHarness<Record<string, never>>, client: unknown): void {
  frameworkCast<{
    client: unknown;
  }>(harness).client = client;
}

//#endregion

//#region Rig

interface E2eRig {
  updates: AcpSessionNotification[];
  connection: Awaited<ReturnType<typeof openAcpConnection>>;
  session: Awaited<ReturnType<Awaited<ReturnType<typeof openAcpConnection>>['newSession']>>;
  close(): Promise<void>;
}

async function serveRealHarness(
  harness: AgentHarness<Record<string, never>>,
  serveOptions: AcpServeOptions,
  clientPermissions?: {
    default: 'allow' | 'deny';
  },
): Promise<E2eRig> {
  const transport = await loopbackTransport(toAcpAgent(harness, serveOptions))({
    cwd: '/workspace',
  });
  const updates: AcpSessionNotification[] = [];
  const connection = await openAcpConnection({
    agentId: 'e2e-serve',
    transport,
    host: {
      cwd: '/workspace',
      fs: new MemoryFs(),
      shell: new RecordingShell(),
      threadId: 'e2e-client',
      permissions: clientPermissions,
      onSessionUpdate: (notification) => {
        updates.push(notification);
      },
    },
  });
  const session = await connection.newSession({
    cwd: '/workspace',
  });
  return {
    updates,
    connection,
    session,
    close: () => connection.close(),
  };
}

function toolCallUpdates(updates: AcpSessionNotification[]): Array<{
  status?: string | null;
  toolCallId: string;
  contentText: string;
}> {
  const out: Array<{
    status?: string | null;
    toolCallId: string;
    contentText: string;
  }> = [];
  for (const notification of updates) {
    const update = notification.update;
    if (update.sessionUpdate !== 'tool_call_update') {
      continue;
    }
    const texts: string[] = [];
    for (const entry of update.content ?? []) {
      if (entry.type === 'content' && entry.content.type === 'text') {
        texts.push(entry.content.text);
      }
    }
    out.push({
      status: update.status,
      toolCallId: update.toolCallId,
      contentText: texts.join(''),
    });
  }
  return out;
}

const DeployInput = z.object({
  what: z.string(),
});

//#endregion

describe('real AgentHarness served over ACP (end to end)', () => {
  it('a policy-denied tool NEVER runs and reports failed with the refusal', async () => {
    let toolRan = false;
    const deploy = tool({
      name: 'deploy',
      description: 'Deploy something',
      input: DeployInput,
      output: z.object({
        ok: z.boolean(),
      }),
      execute: async () => {
        toolRan = true;
        return {
          ok: true,
        };
      },
      acp: {
        kind: 'execute',
      },
    });
    /** The harness's OWN observational layer — proves additive injection. */
    const observedCallIds: Array<string | undefined> = [];
    const observerLayer = frameworkCast<ContextLayer>({
      id: 'observer',
      slot: 10,
      scope: 'execution',
      hooks: {
        beforeToolCall: async (params: { callId?: string }) => {
          observedCallIds.push(params.callId);
          return {
            decision: {
              action: 'allow',
            },
          };
        },
      },
    });
    const graph: Step<ContextData, string, string> = frameworkCast<
      Step<ContextData, string, string>
    >({
      kind: 'callModel',
      id: 'act',
      model: 'test/model',
      tools: [
        deploy,
      ],
    });
    const harness = new AgentHarness({
      name: 'e2e-deny',
      agentGraph: graph,
      params: {},
      contextLayers: [
        observerLayer,
      ],
    });
    installClient(
      harness,
      new ToolCallThenDoneClient('deploy', {
        what: 'prod',
      }),
    );

    const rig = await serveRealHarness(harness, {
      tools: [
        {
          name: 'deploy',
          acp: deploy.acp,
        },
      ],
      permissions: {
        rules: [
          {
            tool: 'deploy',
            decision: 'deny',
          },
        ],
      },
    });
    const result = await rig.session.prompt({
      content: [
        {
          type: 'text',
          text: 'deploy to prod',
        },
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(toolRan).toBe(false);
    const completions = toolCallUpdates(rig.updates);
    const failed = completions.find((u) => u.status === 'failed');
    assert(failed);
    expect(failed.toolCallId).toBe('call-e2e-1');
    expect(failed.contentText).toContain('denied');
    // The harness's own layer ran alongside the injected gate, and core
    // handed it the model's callId — the additive-injection + correlation
    // guarantees, proven on the real pipeline.
    expect(observedCallIds).toEqual([
      'call-e2e-1',
    ]);
    await rig.close();
  });

  it('an allowed tool runs, completes with its output, and the reply streams', async () => {
    let toolRan = false;
    const add = tool({
      name: 'add',
      description: 'Add two numbers',
      input: z.object({
        a: z.number(),
        b: z.number(),
      }),
      output: z.object({
        sum: z.number(),
      }),
      execute: async (args) => {
        toolRan = true;
        return {
          sum: args.a + args.b,
        };
      },
    });
    const graph: Step<ContextData, string, string> = frameworkCast<
      Step<ContextData, string, string>
    >({
      kind: 'callModel',
      id: 'act',
      model: 'test/model',
      tools: [
        add,
      ],
    });
    const harness = new AgentHarness({
      name: 'e2e-allow',
      agentGraph: graph,
      params: {},
    });
    installClient(
      harness,
      new ToolCallThenDoneClient('add', {
        a: 2,
        b: 3,
      }),
    );

    const rig = await serveRealHarness(harness, {});
    const result = await rig.session.prompt({
      content: [
        {
          type: 'text',
          text: 'add 2 and 3',
        },
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(toolRan).toBe(true);
    const completions = toolCallUpdates(rig.updates);
    const completed = completions.find((u) => u.status === 'completed');
    assert(completed);
    expect(completed.contentText).toContain('5');
    expect(completions.some((u) => u.status === 'failed')).toBe(false);
    await rig.close();
  });

  it('an ask flows pending → in_progress (grant) → completed over the wire', async () => {
    const add = tool({
      name: 'add',
      description: 'Add two numbers',
      input: z.object({
        a: z.number(),
        b: z.number(),
      }),
      output: z.object({
        sum: z.number(),
      }),
      execute: async (args) => ({
        sum: args.a + args.b,
      }),
    });
    const graph: Step<ContextData, string, string> = frameworkCast<
      Step<ContextData, string, string>
    >({
      kind: 'callModel',
      id: 'act',
      model: 'test/model',
      tools: [
        add,
      ],
    });
    const harness = new AgentHarness({
      name: 'e2e-ask',
      agentGraph: graph,
      params: {},
    });
    installClient(
      harness,
      new ToolCallThenDoneClient('add', {
        a: 1,
        b: 1,
      }),
    );

    const rig = await serveRealHarness(
      harness,
      {
        tools: [
          {
            name: 'add',
          },
        ],
        permissions: {
          rules: [
            {
              tool: 'add',
              decision: 'ask',
            },
          ],
        },
      },
      {
        default: 'allow',
      },
    );
    const result = await rig.session.prompt({
      content: [
        {
          type: 'text',
          text: 'add',
        },
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    const toolCall = rig.updates.map((n) => n.update).find((u) => u.sessionUpdate === 'tool_call');
    assert(toolCall && toolCall.sessionUpdate === 'tool_call');
    expect(toolCall.status).toBe('pending');
    const statuses = toolCallUpdates(rig.updates).map((u) => u.status);
    // The grant moves the pending call to in_progress before the real
    // completion lands — the sendGrantProgress path, on the wire answerer.
    expect(statuses).toContain('in_progress');
    expect(statuses).toContain('completed');
    await rig.close();
  });

  it('session/cancel aborts a genuinely-running turn and resolves cancelled', async () => {
    const hangChannel = channel('e2e-hang', {
      schema: z.string(),
      mode: 'queue',
    });
    const graph: Step<ContextData, string, string> = frameworkCast<
      Step<ContextData, string, string>
    >({
      kind: 'runCode',
      id: 'hang',
      execute: async (
        _input: string,
        ctx: {
          recv: (c: unknown, o: unknown) => Promise<string>;
        },
      ) =>
        ctx.recv(hangChannel, {
          timeout: 60_000,
        }),
    });
    const harness = new AgentHarness({
      name: 'e2e-cancel',
      agentGraph: graph,
      params: {},
    });

    const rig = await serveRealHarness(harness, {});
    const turn = rig.session.prompt({
      content: [
        {
          type: 'text',
          text: 'hang forever',
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rig.session.cancel();

    const result = await turn;
    // Classified through the REAL chain: ctx.abort rejects the recv with a
    // cancelled NoeticError, the runner stamps errorKind: 'cancelled' on
    // turn_aborted, and the pump maps it — no fabricated events anywhere.
    expect(result.stopReason).toBe('cancelled');
    await rig.close();
  });
});
