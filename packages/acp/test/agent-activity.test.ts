/**
 * An agent's activity, as a host sees it, over the real JSON-RPC wire: a
 * step's agent reports its plan, mode, model, a call's presentation, progress
 * and structured content, and an image in its answer, and the harness puts
 * them on the generic events — the same fields a `callModel` step's tool calls
 * carry, and nothing that names the protocol (spec 08 § Tool calls, plans and
 * agent settings; spec 27 § Output → harness events).
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type * as acp from '@agentclientprotocol/sdk';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ContextData } from '@noetic-tools/context';
import { AgentHarness, execute, step, toolWithGenerator } from '@noetic-tools/core';
import type { AgentScope, LLMResponse, Step } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { defineAcpAgent } from '../src/define';
import { claudeToolWiring } from '../src/tool-wiring';
import { loopbackMachine } from '../src/transport-loopback';

//#region Helpers

interface Captured {
  source: string;
  type: string;
  data: Record<string, unknown>;
  scope?: AgentScope;
}

function capture(name: string): {
  harness: AgentHarness;
  ctx: ReturnType<AgentHarness['createContext']>;
  events: Captured[];
} {
  const harness = new AgentHarness({
    name,
    params: {},
    approveToolCall: () => ({
      action: 'allow',
    }),
  });
  const ctx = harness.createContext();
  const events: Captured[] = [];
  Reflect.set(ctx, '_broadcaster', {
    emit(event: Captured) {
      events.push(event);
    },
  });
  return {
    harness,
    ctx,
    events,
  };
}

function framework(events: Captured[], name: string): Array<Record<string, unknown>> {
  return events.filter((event) => event.type.endsWith(`:${name}`)).map((event) => event.data);
}

function update(
  conn: acp.AgentSideConnection,
  sessionId: string,
  sessionUpdate: acp.SessionNotification['update'],
): Promise<void> {
  return conn.sessionUpdate({
    sessionId,
    update: sessionUpdate,
  });
}

/** An agent whose prompt turn runs `turn`, then answers. */
function scriptedAgent(
  turn: (
    conn: acp.AgentSideConnection,
    sessionId: string,
    servers: acp.McpServer[],
  ) => Promise<void>,
): (conn: acp.AgentSideConnection) => acp.Agent {
  return (conn) => {
    let servers: acp.McpServer[] = [];
    return {
      async initialize() {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            mcpCapabilities: {
              http: true,
            },
          },
        };
      },
      async newSession(params) {
        servers = params.mcpServers;
        return {
          sessionId: 'session-1',
        };
      },
      async authenticate() {},
      async cancel() {},
      async prompt(params) {
        await turn(conn, params.sessionId, servers);
        return {
          stopReason: 'end_turn',
        };
      },
    };
  };
}

function agentStep(
  id: string,
  agent: (conn: acp.AgentSideConnection) => acp.Agent,
  tools: Parameters<typeof step.acpAgent>[0]['tools'] = [],
) {
  return step.acpAgent<ContextData, unknown, string>({
    id,
    agent: defineAcpAgent({
      agentId: 'scripted',
      command: {
        command: 'scripted',
      },
      machine: loopbackMachine(agent),
      tools: claudeToolWiring,
    }),
    prompt: 'go',
    tools,
  });
}

//#endregion

//#region A tool that presents itself

const writeFile = toolWithGenerator({
  name: 'write_file',
  description: 'Write a file.',
  input: z.object({
    path: z.string(),
    text: z.string(),
  }),
  event: z.number(),
  output: z.object({
    path: z.string(),
    before: z.string(),
    after: z.string(),
  }),
  presentation: {
    kind: 'edit',
    title: ({ path }) => `Write ${path}`,
    locations: ({ path }) => [
      {
        path,
        line: 1,
      },
    ],
    progress: (events) => ({
      progress: events.length / 2,
    }),
    content: (output) => [
      {
        type: 'diff',
        path: output.path,
        oldText: output.before,
        newText: output.after,
      },
    ],
  },
  async *execute({ path, text }) {
    yield 1;
    yield 2;
    return {
      path,
      before: 'old',
      after: text,
    };
  },
});

const ARGS = {
  path: 'src/a.ts',
  text: 'new',
};

/** A model that calls `write_file` once, then answers. */
function scriptedModel(): unknown {
  let round = 0;
  const response = (output: unknown[]): LLMResponse =>
    frameworkCast<LLMResponse>({
      id: `resp-${round}`,
      status: 'completed',
      output,
      items: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
      },
    });
  return {
    callModel: () => ({
      async *getFullResponsesStream() {},
      getResponse: async () => {
        round += 1;
        if (round === 1) {
          return response([
            {
              id: 'fc-1',
              status: 'completed',
              type: 'function_call',
              callId: 'call-1',
              name: 'write_file',
              arguments: JSON.stringify(ARGS),
            },
          ]);
        }
        return response([
          {
            id: 'msg',
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
        ]);
      },
    }),
  };
}

/** An agent that calls the step's `write_file` over the tool bridge, as Claude Code does. */
async function callBridgedTool(
  conn: acp.AgentSideConnection,
  sessionId: string,
  servers: acp.McpServer[],
): Promise<void> {
  const server = servers.find((candidate) => candidate.name === 'noetic');
  assert(server && 'type' in server && server.type === 'http');
  const client = new Client({
    name: 'scripted',
    version: '0.0.0',
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        headers: Object.fromEntries(
          server.headers.map((header) => [
            header.name,
            header.value,
          ]),
        ),
      },
    }),
  );
  const toolCallId = 'toolu_1';
  await update(conn, sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'mcp__noetic__write_file',
    kind: 'other',
    status: 'pending',
    rawInput: ARGS,
  });
  await client.callTool({
    name: 'write_file',
    arguments: ARGS,
    _meta: {
      'claudecode/toolUseId': toolCallId,
    },
  });
  await client.close();
}

//#endregion

describe("an agent step's activity, over the wire", () => {
  it('reaches the host as generic events: plan, mode, model, presentation, progress, content, image', async () => {
    const { ctx, events } = capture('activity');
    const agent = scriptedAgent(async (conn, sessionId) => {
      await update(conn, sessionId, {
        sessionUpdate: 'plan',
        entries: [
          {
            content: 'Edit a.ts',
            priority: 'high',
            status: 'in_progress',
          },
        ],
      });
      await update(conn, sessionId, {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'acceptEdits',
      });
      await update(conn, sessionId, {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            category: 'model',
            currentValue: 'opus',
            options: [
              {
                value: 'opus',
                name: 'Opus',
              },
            ],
          },
        ],
      });
      await update(conn, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'edit-1',
        title: 'Edit src/a.ts',
        kind: 'edit',
        status: 'in_progress',
        locations: [
          {
            path: '/repo/src/a.ts',
            line: 3,
          },
        ],
        rawInput: {
          file_path: '/repo/src/a.ts',
        },
      });
      await update(conn, sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'edit-1',
        _meta: {
          progress: 0.5,
        },
        content: [
          {
            type: 'diff',
            path: '/repo/src/a.ts',
            oldText: 'a',
            newText: 'b',
          },
        ],
      });
      await update(conn, sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'edit-1',
        status: 'completed',
      });
      await update(conn, sessionId, {
        sessionUpdate: 'plan',
        entries: [],
      });
      await update(conn, sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'image',
          mimeType: 'image/png',
          data: 'iVBORw0KGgo=',
        },
      });
      await update(conn, sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Edited.',
        },
      });
    });

    const output = await execute(agentStep('coder', agent), undefined, ctx);

    expect(output).toBe('Edited.');
    expect(events.filter((event) => /acp/i.test(event.type))).toEqual([]);
    expect(framework(events, 'plan_updated')).toEqual([
      {
        stepId: 'coder',
        plan: {
          entries: [
            {
              content: 'Edit a.ts',
              priority: 'high',
              status: 'in_progress',
            },
          ],
        },
      },
      {
        stepId: 'coder',
        plan: {
          entries: [],
        },
      },
    ]);
    expect(framework(events, 'agent_config_updated')).toEqual([
      {
        stepId: 'coder',
        mode: 'acceptEdits',
      },
      {
        stepId: 'coder',
        model: 'opus',
      },
    ]);
    expect(framework(events, 'tool_call_started')).toEqual([
      {
        name: 'Edit src/a.ts',
        callId: 'edit-1',
        title: 'Edit src/a.ts',
        kind: 'edit',
        status: 'in_progress',
        locations: [
          {
            path: '/repo/src/a.ts',
            line: 3,
          },
        ],
      },
    ]);
    const diff = {
      type: 'diff',
      path: '/repo/src/a.ts',
      oldText: 'a',
      newText: 'b',
    };
    expect(framework(events, 'tool_progress')).toEqual([
      {
        name: 'Edit src/a.ts',
        callId: 'edit-1',
        progress: 0.5,
        content: [
          diff,
        ],
      },
    ]);
    expect(framework(events, 'tool_call_completed')).toEqual([
      {
        name: 'Edit src/a.ts',
        callId: 'edit-1',
        error: false,
        content: [
          diff,
        ],
      },
    ]);
    const images = events.filter(
      (event) =>
        event.type === 'response.output_item.done' &&
        frameworkCast<{
          type?: string;
        }>(event.data.item).type === 'image_generation_call',
    );
    expect(images.map((event) => event.data.item)).toEqual([
      expect.objectContaining({
        result: 'data:image/png;base64,iVBORw0KGgo=',
      }),
    ]);
  });

  it("presents a step tool's call the same through the tool bridge as in callModel", async () => {
    const model = capture('model-path');
    frameworkCast<{
      llm: {
        client: unknown;
      };
    }>(model.harness).llm.client = scriptedModel();
    await execute(
      frameworkCast<Step<ContextData, string, string>>({
        kind: 'callModel',
        id: 'act',
        model: 'test/model',
        tools: [
          writeFile,
        ],
      }),
      'go',
      model.ctx,
    );

    const bridged = capture('bridge-path');
    await execute(
      agentStep('delegate', scriptedAgent(callBridgedTool), [
        writeFile,
      ]),
      undefined,
      bridged.ctx,
    );

    const presentation = {
      name: 'write_file',
      title: 'Write src/a.ts',
      kind: 'edit',
      locations: [
        {
          path: 'src/a.ts',
          line: 1,
        },
      ],
    };
    const content = [
      {
        type: 'diff',
        path: 'src/a.ts',
        oldText: 'old',
        newText: 'new',
      },
    ];
    for (const { events } of [
      model,
      bridged,
    ]) {
      expect(framework(events, 'tool_call_started')).toEqual([
        expect.objectContaining(presentation),
      ]);
      expect(framework(events, 'tool_progress').map((data) => data.progress)).toEqual([
        0.5,
        1,
      ]);
      expect(framework(events, 'tool_call_completed')).toEqual([
        expect.objectContaining({
          name: 'write_file',
          error: false,
          content,
        }),
      ]);
    }
  });
});
