/**
 * The host features a coding host needs without rewriting ACP lines itself
 * (spec 27 § Session settings, § Elicitation, § Subagents, § What the session
 * runs with). Every assertion travels the real JSON-RPC wire between a Noetic
 * client and an `AgentSideConnection`.
 */

import { describe, expect, test } from 'bun:test';
import type * as acp from '@agentclientprotocol/sdk';
import type { AcpSubagentEvent } from '@noetic-tools/types';
import { frameworkCast, isAcpCapabilityError } from '@noetic-tools/types';
import { announcedChild } from '../src/connection';
import { createAcpTestRig, textChunk } from './_helpers';

const PROMPT: acp.ContentBlock[] = [
  {
    type: 'text',
    text: 'go',
  },
];

const APPEND_CAPABLE: acp.AgentCapabilities = {
  sessionCapabilities: {
    systemPrompt: {},
  },
};

const claudeFallback = (prompt: {
  text: string;
  mode: 'append' | 'override';
}): Record<string, unknown> | undefined =>
  prompt.mode === 'append'
    ? {
        systemPrompt: {
          append: prompt.text,
        },
      }
    : undefined;

//#region Session settings

describe('session _meta', () => {
  test('is sent verbatim on session/new', async () => {
    const rig = await createAcpTestRig();
    const meta = {
      claudeCode: {
        options: {
          strictMcpConfig: true,
          tools: [],
          extraArgs: {
            'thinking-display': 'summarized',
          },
        },
      },
    };
    await rig.connection.newSession({
      cwd: '/workspace',
      meta,
    });
    expect(rig.calls.newSession[0]?._meta).toEqual(meta);
    await rig.close();
  });

  test('is sent on session/load too', async () => {
    const rig = await createAcpTestRig({
      script: {
        capabilities: {
          loadSession: true,
        },
      },
    });
    await rig.connection.loadSession({
      sessionId: 'earlier',
      cwd: '/workspace',
      meta: {
        k: 1,
      },
    });
    expect(rig.calls.loadSession[0]?._meta).toEqual({
      k: 1,
    });
    await rig.close();
  });

  test('is left off when none is given', async () => {
    const rig = await createAcpTestRig();
    await rig.connection.newSession({
      cwd: '/workspace',
    });
    expect(rig.calls.newSession[0]?._meta).toBeUndefined();
    expect(rig.calls.newSession[0]?.systemPrompt).toBeUndefined();
    await rig.close();
  });
});

describe('system prompt', () => {
  test('goes as the protocol systemPrompt when the agent advertises it', async () => {
    const rig = await createAcpTestRig({
      script: {
        capabilities: APPEND_CAPABLE,
      },
      systemPromptMeta: claudeFallback,
    });
    await rig.connection.newSession({
      cwd: '/workspace',
      systemPrompt: {
        text: 'Follow the house rules.',
      },
    });
    const sent = rig.calls.newSession[0];
    expect(sent?.systemPrompt).toEqual({
      mode: 'append',
      content: [
        {
          type: 'text',
          text: 'Follow the house rules.',
        },
      ],
    });
    // The native field wins: no fallback extension alongside it.
    expect(sent?._meta).toBeUndefined();
    await rig.close();
  });

  test("falls back to the agent's _meta when the capability is not advertised", async () => {
    const rig = await createAcpTestRig({
      systemPromptMeta: claudeFallback,
    });
    await rig.connection.newSession({
      cwd: '/workspace',
      systemPrompt: {
        text: 'Follow the house rules.',
      },
      meta: {
        claudeCode: {
          options: {
            model: 'opus',
          },
        },
      },
    });
    const sent = rig.calls.newSession[0];
    expect(sent?.systemPrompt).toBeUndefined();
    expect(sent?._meta).toEqual({
      systemPrompt: {
        append: 'Follow the house rules.',
      },
      claudeCode: {
        options: {
          model: 'opus',
        },
      },
    });
    await rig.close();
  });

  test('a step _meta key wins over the fallback', async () => {
    const rig = await createAcpTestRig({
      systemPromptMeta: claudeFallback,
    });
    await rig.connection.newSession({
      cwd: '/workspace',
      systemPrompt: {
        text: 'fallback text',
      },
      meta: {
        systemPrompt: {
          append: 'step text',
        },
      },
    });
    expect(rig.calls.newSession[0]?._meta).toEqual({
      systemPrompt: {
        append: 'step text',
      },
    });
    await rig.close();
  });

  test('is refused, not dropped, with no capability and no fallback', async () => {
    const rig = await createAcpTestRig();
    const error = await rig.connection
      .newSession({
        cwd: '/workspace',
        systemPrompt: {
          text: 'rules',
        },
      })
      .catch((e: unknown) => e);
    expect(isAcpCapabilityError(error)).toBe(true);
    assertCapability(error, 'sessionCapabilities.systemPrompt');
    expect(rig.calls.newSession).toHaveLength(0);
    await rig.close();
  });

  test('override needs the override mode capability', async () => {
    const rig = await createAcpTestRig({
      script: {
        capabilities: APPEND_CAPABLE,
      },
      systemPromptMeta: claudeFallback,
    });
    const error = await rig.connection
      .newSession({
        cwd: '/workspace',
        systemPrompt: {
          text: 'rules',
          mode: 'override',
        },
      })
      .catch((e: unknown) => e);
    assertCapability(error, 'sessionCapabilities.systemPrompt.mode.override');
    await rig.close();
  });

  test('override goes out when the agent advertises it', async () => {
    const rig = await createAcpTestRig({
      script: {
        capabilities: {
          sessionCapabilities: {
            systemPrompt: {
              mode: {
                override: {},
              },
            },
          },
        },
      },
    });
    await rig.connection.newSession({
      cwd: '/workspace',
      systemPrompt: {
        text: 'only these rules',
        mode: 'override',
      },
    });
    expect(rig.calls.newSession[0]?.systemPrompt?.mode).toBe('override');
    await rig.close();
  });
});

function assertCapability(error: unknown, capability: string): void {
  if (!isAcpCapabilityError(error)) {
    throw new Error(`expected an AcpCapabilityError, got ${String(error)}`);
  }
  expect(error.capability).toBe(capability);
}

//#endregion

//#region Elicitation

const FORM_REQUEST = (sessionId: string): acp.CreateElicitationRequest => ({
  mode: 'form',
  sessionId,
  message: 'Which branch?',
  requestedSchema: {
    type: 'object',
    properties: {
      branch: {
        type: 'string',
      },
    },
  },
});

describe('elicitation', () => {
  test('advertises form elicitation when the host answers it', async () => {
    const rig = await createAcpTestRig({
      onElicitation: async () => ({
        action: 'decline',
      }),
    });
    expect(rig.calls.initialize[0]?.clientCapabilities?.elicitation).toEqual({
      form: {},
    });
    await rig.close();
  });

  test('advertises nothing without a handler, and capability config overrides', async () => {
    const bare = await createAcpTestRig();
    expect(bare.calls.initialize[0]?.clientCapabilities?.elicitation).toBeUndefined();
    await bare.close();
    const withdrawn = await createAcpTestRig({
      capabilities: {
        elicitation: false,
      },
      onElicitation: async () => ({
        action: 'decline',
      }),
    });
    expect(withdrawn.calls.initialize[0]?.clientCapabilities?.elicitation).toBeUndefined();
    await withdrawn.close();
  });

  test("the agent's request is answered by the handler", async () => {
    let asked: acp.CreateElicitationRequest | undefined;
    let answer: acp.CreateElicitationResponse | undefined;
    const rig = await createAcpTestRig({
      onElicitation: async (request) => {
        asked = request;
        return {
          action: 'accept',
          content: {
            branch: 'main',
          },
        };
      },
      script: {
        onPrompt: async (conn, params) => {
          answer = await conn.createElicitation(FORM_REQUEST(params.sessionId));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });
    expect(asked?.message).toBe('Which branch?');
    expect(answer).toEqual({
      action: 'accept',
      content: {
        branch: 'main',
      },
    });
    await rig.close();
  });

  test('a throwing handler, or none, answers cancel', async () => {
    const answers: acp.CreateElicitationResponse[] = [];
    const rig = await createAcpTestRig({
      onElicitation: async () => {
        throw new Error('no person');
      },
      script: {
        onPrompt: async (conn, params) => {
          answers.push(await conn.createElicitation(FORM_REQUEST(params.sessionId)));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });
    rig.host.onElicitation = undefined;
    await session.prompt({
      content: PROMPT,
    });
    expect(answers).toEqual([
      {
        action: 'cancel',
      },
      {
        action: 'cancel',
      },
    ]);
    await rig.close();
  });
});

//#endregion

//#region Subagents

function subagentAnnounce(parent: string, child: string): acp.SessionNotification {
  return {
    sessionId: parent,
    update: {
      sessionUpdate: 'subagent_update',
      sessionId: child,
      title: 'Explore',
      capabilities: {
        cancel: {},
      },
      state: {
        state: 'running',
      },
    },
  };
}

describe('subagents', () => {
  test('advertises the capability when the host takes subagent updates', async () => {
    const rig = await createAcpTestRig({
      onSubagentUpdate: () => undefined,
    });
    expect(rig.calls.initialize[0]?.clientCapabilities?.subagents).toEqual({});
    await rig.close();
    const bare = await createAcpTestRig();
    expect(bare.calls.initialize[0]?.clientCapabilities?.subagents).toBeUndefined();
    await bare.close();
  });

  test("a child session's updates go to the handler and never to the step", async () => {
    const events: AcpSubagentEvent[] = [];
    const rig = await createAcpTestRig({
      onSubagentUpdate: (event) => {
        events.push(event);
      },
      script: {
        onPrompt: async (conn, params) => {
          const parent = params.sessionId;
          await conn.sessionUpdate(subagentAnnounce(parent, 'child-1'));
          await conn.sessionUpdate(textChunk('child-1', 'subagent text'));
          // A nested subagent, announced on its parent subagent's session.
          await conn.sessionUpdate(subagentAnnounce('child-1', 'child-2'));
          await conn.sessionUpdate(textChunk('child-2', 'nested text'));
          await conn.sessionUpdate(textChunk(parent, 'the answer'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    const result = await session.prompt({
      content: PROMPT,
    });

    expect(result.text).toBe('the answer');
    // The step sees its own session only: the top-level announcement (raw)
    // and its answer — no subagent text, no nested announcement.
    expect(rig.updates.map((n) => n.sessionId)).toEqual([
      session.sessionId,
      session.sessionId,
    ]);
    expect(rig.updates.map((n) => n.update.sessionUpdate)).toEqual([
      'subagent_update',
      'agent_message_chunk',
    ]);
    expect(
      events.map((e) => [
        e.sessionId,
        e.parentSessionId,
        e.update.sessionUpdate,
      ]),
    ).toEqual([
      [
        'child-1',
        session.sessionId,
        'subagent_update',
      ],
      [
        'child-1',
        session.sessionId,
        'agent_message_chunk',
      ],
      [
        'child-2',
        'child-1',
        'subagent_update',
      ],
      [
        'child-2',
        'child-1',
        'agent_message_chunk',
      ],
    ]);
    await rig.close();
  });

  test('cancel sends session/cancel for the child alone', async () => {
    let child: AcpSubagentEvent | undefined;
    const rig = await createAcpTestRig({
      onSubagentUpdate: (event) => {
        child ??= event;
      },
      script: {
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate(subagentAnnounce(params.sessionId, 'child-9'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });
    await child?.cancel();
    await waitFor(() => rig.calls.cancel.length > 0);
    expect(rig.calls.cancel).toEqual([
      {
        sessionId: 'child-9',
      },
    ]);
    await rig.close();
  });

  test("codex-acp's draft subagent_spawned announces a child too", async () => {
    const events: AcpSubagentEvent[] = [];
    const rig = await createAcpTestRig({
      onSubagentUpdate: (event) => {
        events.push(event);
      },
      script: {
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate(
            frameworkCast<acp.SessionNotification>({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'subagent_spawned',
                subagentSessionId: 'codex-child',
                name: 'worker',
                task: 'look around',
                capabilities: {},
              },
            }),
          );
          await conn.sessionUpdate(textChunk('codex-child', 'worker text'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    const result = await session.prompt({
      content: PROMPT,
    });
    expect(result.text).toBe('');
    expect(events.map((e) => e.sessionId)).toEqual([
      'codex-child',
      'codex-child',
    ]);
    expect(rig.updates.every((n) => n.sessionId === session.sessionId)).toBe(true);
    await rig.close();
  });

  test('an announcement on a session the connection does not own registers nothing', async () => {
    const events: AcpSubagentEvent[] = [];
    const rig = await createAcpTestRig({
      onSubagentUpdate: (event) => {
        events.push(event);
      },
      script: {
        onPrompt: async (conn) => {
          await conn.sessionUpdate(subagentAnnounce('stranger', 'orphan'));
          await conn.sessionUpdate(textChunk('orphan', 'x'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });
    expect(events).toHaveLength(0);
    await rig.close();
  });
});

describe('announcedChild', () => {
  test('reads both the RFD and the draft announcement, and nothing else', () => {
    expect(announcedChild(subagentAnnounce('p', 'c').update)).toBe('c');
    expect(
      announcedChild(
        frameworkCast<acp.SessionUpdate>({
          sessionUpdate: 'subagent_spawned',
          subagentSessionId: 'd',
        }),
      ),
    ).toBe('d');
    expect(
      announcedChild(
        frameworkCast<acp.SessionUpdate>({
          sessionUpdate: 'subagent_spawned',
        }),
      ),
    ).toBeUndefined();
    expect(announcedChild(textChunk('p', 'x').update)).toBeUndefined();
  });
});

//#endregion

//#region What the session runs with

describe('turn result', () => {
  test('carries the config options, mode and response _meta', async () => {
    const rig = await createAcpTestRig({
      script: {
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            category: 'model',
            currentValue: 'sonnet',
            options: [
              {
                value: 'sonnet',
                name: 'Sonnet',
              },
              {
                value: 'opus',
                name: 'Opus',
              },
            ],
          },
        ],
        modes: {
          currentModeId: 'default',
          availableModes: [
            {
              id: 'default',
              name: 'Default',
            },
          ],
        },
        responseMeta: {
          quota: {
            token_count: {
              inputTokens: 10,
              outputTokens: 3,
            },
          },
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.setModel('opus');
    const result = await session.prompt({
      content: PROMPT,
    });
    const model = result.configOptions?.find((option) => option.id === 'model');
    expect(model?.type === 'select' ? model.currentValue : undefined).toBe('opus');
    expect(result.currentModeId).toBe('default');
    expect(result.responseMeta).toEqual({
      quota: {
        token_count: {
          inputTokens: 10,
          outputTokens: 3,
        },
      },
    });
    await rig.close();
  });
});

//#endregion

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting');
}
