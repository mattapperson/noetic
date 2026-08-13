/**
 * End-to-end ACP protocol tests over the loopback transport. Every assertion
 * here travels the real JSON-RPC wire between a Noetic client and an
 * `AgentSideConnection`.
 */

import { describe, expect, test } from 'bun:test';
import { AcpCapabilityError, isAcpCapabilityError } from '@noetic-tools/types';
import type * as acp from '@zed-industries/agent-client-protocol';
import { PROTOCOL_VERSION } from '@zed-industries/agent-client-protocol';
import { assertPromptContentSupported } from '../src/connection';
import { createAcpTestRig, textChunk } from './_helpers';

const TEXT_PROMPT: acp.ContentBlock[] = [
  {
    type: 'text',
    text: 'hello',
  },
];

describe('initialize', () => {
  test('negotiates the protocol version and advertises client capabilities', async () => {
    const rig = await createAcpTestRig();

    const request = rig.calls.initialize[0];
    expect(request).toBeDefined();
    expect(request?.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(request?.clientCapabilities?.fs?.readTextFile).toBe(true);
    expect(request?.clientCapabilities?.fs?.writeTextFile).toBe(true);
    expect(request?.clientCapabilities?.terminal).toBe(true);
    expect(rig.connection.protocolVersion).toBe(PROTOCOL_VERSION);

    await rig.close();
  });

  test('withdraws a capability the step disabled', async () => {
    const rig = await createAcpTestRig({
      capabilities: {
        writeTextFile: false,
        terminal: false,
      },
    });

    const caps = rig.calls.initialize[0]?.clientCapabilities;
    expect(caps?.fs?.readTextFile).toBe(true);
    expect(caps?.fs?.writeTextFile).toBe(false);
    expect(caps?.terminal).toBe(false);

    await rig.close();
  });

  test('exposes the agent capabilities and auth methods it advertised', async () => {
    const rig = await createAcpTestRig({
      script: {
        capabilities: {
          loadSession: true,
          promptCapabilities: {
            image: true,
          },
        },
        authMethods: [
          {
            id: 'oauth',
            name: 'OAuth',
            description: null,
          },
        ],
      },
    });

    expect(rig.connection.agentCapabilities.loadSession).toBe(true);
    expect(rig.connection.authMethods).toHaveLength(1);
    expect(rig.connection.authMethods[0]?.id).toBe('oauth');

    await rig.connection.authenticate('oauth');
    expect(rig.calls.authenticate[0]?.methodId).toBe('oauth');

    await rig.close();
  });
});

describe('prompt turn', () => {
  test('accumulates assistant text and returns the stop reason', async () => {
    const rig = await createAcpTestRig({
      script: {
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate(textChunk(params.sessionId, 'Hello, '));
          await conn.sessionUpdate(textChunk(params.sessionId, 'world.'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });

    const result = await session.prompt({
      content: TEXT_PROMPT,
    });

    expect(result.text).toBe('Hello, world.');
    expect(result.stopReason).toBe('end_turn');
    expect(result.items).toHaveLength(1);
    expect(rig.updates).toHaveLength(2);

    await rig.close();
  });

  test('turns a tool call and its completion into paired items', async () => {
    const rig = await createAcpTestRig({
      script: {
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call-1',
              title: 'Read config.json',
              kind: 'read',
              status: 'pending',
              rawInput: {
                path: '/workspace/config.json',
              },
            },
          });
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'call-1',
              status: 'completed',
              content: [
                {
                  type: 'content',
                  content: {
                    type: 'text',
                    text: '{"ok":true}',
                  },
                },
              ],
            },
          });
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });

    const result = await session.prompt({
      content: TEXT_PROMPT,
    });

    const call = result.items.find((item) => item.type === 'function_call');
    const output = result.items.find((item) => item.type === 'function_call_output');
    expect(call).toBeDefined();
    expect(output).toBeDefined();
    assertFunctionCall(call);
    assertFunctionCallOutput(output);
    expect(call.name).toBe('Read config.json');
    expect(call.callId).toBe('call-1');
    expect(JSON.parse(call.arguments)).toEqual({
      path: '/workspace/config.json',
    });
    expect(output.output).toBe('{"ok":true}');
    expect(output.status).toBe('completed');

    await rig.close();
  });

  test('captures plan, available commands, and mode updates', async () => {
    const rig = await createAcpTestRig({
      script: {
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'plan',
              entries: [
                {
                  content: 'Read the diff',
                  priority: 'high',
                  status: 'completed',
                },
                {
                  content: 'Summarize risks',
                  priority: 'medium',
                  status: 'pending',
                },
              ],
            },
          });
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [
                {
                  name: 'review',
                  description: 'Review the working tree',
                  input: null,
                },
              ],
            },
          });
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'current_mode_update',
              currentModeId: 'plan',
            },
          });
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });

    const result = await session.prompt({
      content: TEXT_PROMPT,
    });

    expect(result.plan).toHaveLength(2);
    expect(result.plan?.[0]?.status).toBe('completed');
    expect(result.availableCommands?.[0]?.name).toBe('review');
    expect(result.currentModeId).toBe('plan');
    expect(session.availableCommands).toHaveLength(1);

    await rig.close();
  });

  test('reasoning chunks are captured but do not become assistant text', async () => {
    const rig = await createAcpTestRig({
      script: {
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate(textChunk(params.sessionId, 'thinking…', 'agent_thought_chunk'));
          await conn.sessionUpdate(textChunk(params.sessionId, 'answer'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });

    const result = await session.prompt({
      content: TEXT_PROMPT,
    });

    expect(result.text).toBe('answer');
    expect(rig.updates).toHaveLength(2);

    await rig.close();
  });

  test('replayed user_message_chunk history is observed but not re-appended', async () => {
    const rig = await createAcpTestRig({
      script: {
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate(
            textChunk(params.sessionId, 'earlier turn', 'user_message_chunk'),
          );
          await conn.sessionUpdate(textChunk(params.sessionId, 'reply'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });

    const result = await session.prompt({
      content: TEXT_PROMPT,
    });

    expect(result.text).toBe('reply');
    expect(result.items).toHaveLength(1);
    expect(rig.updates).toHaveLength(2);

    await rig.close();
  });

  test.each([
    'end_turn',
    'max_tokens',
    'max_turn_requests',
    'refusal',
    'cancelled',
  ] as const)('surfaces the %s stop reason verbatim', async (stopReason) => {
    const rig = await createAcpTestRig({
      script: {
        stopReason,
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });

    const result = await session.prompt({
      content: TEXT_PROMPT,
    });

    expect(result.stopReason).toBe(stopReason);

    await rig.close();
  });

  test('aborting the turn sends session/cancel', async () => {
    const controller = new AbortController();
    const rig = await createAcpTestRig({
      script: {
        onPrompt: async () => {
          controller.abort();
          // Give the cancel notification a turn of the event loop to arrive.
          await new Promise((resolve) => setTimeout(resolve, 5));
          return 'cancelled';
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });

    const result = await session.prompt({
      content: TEXT_PROMPT,
      signal: controller.signal,
    });

    expect(result.stopReason).toBe('cancelled');
    expect(rig.calls.cancel).toHaveLength(1);
    expect(rig.calls.cancel[0]?.sessionId).toBe(session.sessionId);

    await rig.close();
  });
});

describe('capability gating', () => {
  test('loadSession throws AcpCapabilityError when unadvertised', async () => {
    const rig = await createAcpTestRig();

    expect(
      rig.connection.loadSession({
        sessionId: 'session-1',
        cwd: '/workspace',
      }),
    ).rejects.toThrow(AcpCapabilityError);
    expect(rig.calls.loadSession).toHaveLength(0);

    await rig.close();
  });

  test('loadSession is allowed once advertised', async () => {
    const rig = await createAcpTestRig({
      script: {
        capabilities: {
          loadSession: true,
        },
      },
    });

    const session = await rig.connection.loadSession({
      sessionId: 'session-42',
      cwd: '/workspace',
    });

    expect(session.sessionId).toBe('session-42');
    expect(rig.calls.loadSession[0]?.sessionId).toBe('session-42');

    await rig.close();
  });

  test('setMode throws when the agent advertised no modes', async () => {
    const rig = await createAcpTestRig();
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });

    let captured: unknown;
    try {
      await session.setMode('plan');
    } catch (error) {
      captured = error;
    }
    expect(isAcpCapabilityError(captured)).toBe(true);
    expect(rig.calls.setMode).toHaveLength(0);

    await rig.close();
  });

  test('setMode round-trips when modes are advertised', async () => {
    const rig = await createAcpTestRig({
      script: {
        modes: {
          currentModeId: 'default',
          availableModes: [
            {
              id: 'default',
              name: 'Default',
              description: null,
            },
            {
              id: 'plan',
              name: 'Plan',
              description: null,
            },
          ],
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });

    await session.setMode('plan');

    expect(rig.calls.setMode[0]?.modeId).toBe('plan');

    await rig.close();
  });

  test('an http MCP server is refused unless mcpCapabilities.http is advertised', async () => {
    const rig = await createAcpTestRig();

    expect(
      rig.connection.newSession({
        cwd: '/workspace',
        mcpServers: [
          {
            type: 'http',
            name: 'db',
            url: 'https://example.test/mcp',
            headers: [],
          },
        ],
      }),
    ).rejects.toThrow(AcpCapabilityError);

    await rig.close();
  });

  test('a stdio MCP server always passes through', async () => {
    const rig = await createAcpTestRig();

    await rig.connection.newSession({
      cwd: '/workspace',
      mcpServers: [
        {
          name: 'db',
          command: 'mcp-db',
          args: [],
          env: [],
        },
      ],
    });

    expect(rig.calls.newSession[0]?.mcpServers).toHaveLength(1);

    await rig.close();
  });
});

describe('assertPromptContentSupported', () => {
  test('rejects image content when the agent does not advertise it', () => {
    expect(() =>
      assertPromptContentSupported(
        'fake-agent',
        [
          {
            type: 'image',
            data: 'AAAA',
            mimeType: 'image/png',
          },
        ],
        {},
      ),
    ).toThrow(AcpCapabilityError);
  });

  test('accepts image content once advertised', () => {
    expect(() =>
      assertPromptContentSupported(
        'fake-agent',
        [
          {
            type: 'image',
            data: 'AAAA',
            mimeType: 'image/png',
          },
        ],
        {
          image: true,
        },
      ),
    ).not.toThrow();
  });

  test('rejects embedded resources when embeddedContext is unadvertised', () => {
    expect(() =>
      assertPromptContentSupported(
        'fake-agent',
        [
          {
            type: 'resource_link',
            uri: 'file:///workspace/a.ts',
            name: 'a.ts',
          },
        ],
        {},
      ),
    ).toThrow(AcpCapabilityError);
  });

  test('always accepts plain text', () => {
    expect(() => assertPromptContentSupported('fake-agent', TEXT_PROMPT, undefined)).not.toThrow();
  });
});

//#region assertions

function assertFunctionCall(item: unknown): asserts item is {
  name: string;
  callId: string;
  arguments: string;
} {
  if (
    typeof item !== 'object' ||
    item === null ||
    !('name' in item) ||
    !('callId' in item) ||
    !('arguments' in item)
  ) {
    throw new Error('expected a function_call item');
  }
}

function assertFunctionCallOutput(item: unknown): asserts item is {
  output: string;
  status: string;
} {
  if (typeof item !== 'object' || item === null || !('output' in item) || !('status' in item)) {
    throw new Error('expected a function_call_output item');
  }
}

//#endregion
