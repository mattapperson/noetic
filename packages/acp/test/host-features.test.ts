/**
 * What a session is opened with, what the agent may ask, and whose updates
 * count (spec 27 § Instructions, § Questions the agent asks, § Subagents' own
 * sessions). Every assertion travels the real JSON-RPC wire between a Noetic
 * client and an `AgentSideConnection`.
 */

import { describe, expect, test } from 'bun:test';
import type * as acp from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import { frameworkCast, isAcpCapabilityError } from '@noetic-tools/types';
import { announcedChild, canonicalJson } from '../src/connection';
import { createAcpTestRig, textChunk } from './_helpers';

const PROMPT: acp.ContentBlock[] = [
  {
    type: 'text',
    text: 'go',
  },
];

const CAN_TAKE_INSTRUCTIONS: acp.AgentCapabilities = {
  sessionCapabilities: {
    systemPrompt: {},
  },
};

const claudeFallback = (instructions: string): Record<string, unknown> => ({
  systemPrompt: {
    append: instructions,
  },
});

//#region Instructions and the adapter's session options

describe('instructions', () => {
  test('go as the protocol systemPrompt, appended, when the agent advertises it', async () => {
    const rig = await createAcpTestRig({
      script: {
        capabilities: CAN_TAKE_INSTRUCTIONS,
      },
      instructionsMeta: claudeFallback,
    });
    await rig.connection.newSession({
      cwd: '/workspace',
      instructions: 'Follow the house rules.',
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
    expect(sent?._meta).toBeUndefined();
    await rig.close();
  });

  test("go through the adapter's extension when the agent does not advertise it", async () => {
    const rig = await createAcpTestRig({
      instructionsMeta: claudeFallback,
    });
    await rig.connection.newSession({
      cwd: '/workspace',
      instructions: 'Follow the house rules.',
    });
    const sent = rig.calls.newSession[0];
    expect(sent?.systemPrompt).toBeUndefined();
    expect(sent?._meta).toEqual({
      systemPrompt: {
        append: 'Follow the house rules.',
      },
    });
    await rig.close();
  });

  test('are refused, not dropped, with neither', async () => {
    const rig = await createAcpTestRig();
    const error = await rig.connection
      .newSession({
        cwd: '/workspace',
        instructions: 'rules',
      })
      .catch((e: unknown) => e);
    if (!isAcpCapabilityError(error)) {
      throw new Error(`expected an AcpCapabilityError, got ${String(error)}`);
    }
    expect(error.capability).toBe('sessionCapabilities.systemPrompt');
    expect(rig.calls.newSession).toHaveLength(0);
    await rig.close();
  });

  test('go on session/load too', async () => {
    const rig = await createAcpTestRig({
      script: {
        capabilities: {
          ...CAN_TAKE_INSTRUCTIONS,
          loadSession: true,
        },
      },
    });
    await rig.connection.loadSession({
      sessionId: 'earlier',
      cwd: '/workspace',
      instructions: 'rules',
    });
    expect(rig.calls.loadSession[0]?.systemPrompt?.mode).toBe('append');
    await rig.close();
  });
});

describe("the adapter's sessionMeta", () => {
  test('goes as _meta on every session, over the instructions extension', async () => {
    const rig = await createAcpTestRig({
      instructionsMeta: claudeFallback,
      sessionMeta: {
        claudeCode: {
          options: {
            strictMcpConfig: true,
          },
        },
        systemPrompt: {
          append: 'the adapter wins',
        },
      },
    });
    await rig.connection.newSession({
      cwd: '/workspace',
      instructions: 'the step',
    });
    await rig.connection.newSession({
      cwd: '/workspace',
    });
    expect(rig.calls.newSession[0]?._meta).toEqual({
      claudeCode: {
        options: {
          strictMcpConfig: true,
        },
      },
      systemPrompt: {
        append: 'the adapter wins',
      },
    });
    expect(rig.calls.newSession[1]?._meta).toEqual({
      claudeCode: {
        options: {
          strictMcpConfig: true,
        },
      },
      systemPrompt: {
        append: 'the adapter wins',
      },
    });
    await rig.close();
  });

  test('is left off when there is none', async () => {
    const rig = await createAcpTestRig();
    await rig.connection.newSession({
      cwd: '/workspace',
    });
    expect(rig.calls.newSession[0]?._meta).toBeUndefined();
    await rig.close();
  });
});

describe('fingerprints', () => {
  test("a session's fingerprint is what fingerprintFor says for the same request", async () => {
    const rig = await createAcpTestRig({
      instructionsMeta: claudeFallback,
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
      instructions: 'rules',
    });
    expect(session.fingerprint).toBe(
      rig.connection.fingerprintFor({
        cwd: '/workspace',
        instructions: 'rules',
      }),
    );
    expect(session.fingerprint).not.toBe(
      rig.connection.fingerprintFor({
        cwd: '/workspace',
        instructions: 'other rules',
      }),
    );
    expect(session.fingerprint).not.toBe(
      rig.connection.fingerprintFor({
        cwd: '/elsewhere',
        instructions: 'rules',
      }),
    );
    await rig.close();
  });

  test("the client's path rules are part of it: a different directory grant is a different session", async () => {
    const narrow = await createAcpTestRig();
    const wide = await createAcpTestRig({
      capabilities: {
        additionalDirectories: [
          '/shared',
        ],
      },
    });
    const request = {
      cwd: '/workspace',
    };
    expect(narrow.connection.fingerprintFor(request)).not.toBe(
      wide.connection.fingerprintFor(request),
    );
    await narrow.close();
    await wide.close();
  });

  test('two hosts with the same setup agree', async () => {
    const one = await createAcpTestRig({
      instructionsMeta: claudeFallback,
    });
    const two = await createAcpTestRig({
      instructionsMeta: claudeFallback,
    });
    const request = {
      cwd: '/workspace',
      instructions: 'rules',
    };
    expect(one.connection.fingerprintFor(request)).toBe(two.connection.fingerprintFor(request));
    await one.close();
    await two.close();
  });

  test('canonicalJson ignores key order, and nothing else', () => {
    expect(
      canonicalJson({
        a: 1,
        b: {
          c: 2,
          d: 3,
        },
      }),
    ).toBe(
      canonicalJson({
        b: {
          d: 3,
          c: 2,
        },
        a: 1,
      }),
    );
    expect(
      canonicalJson({
        a: [
          1,
          2,
        ],
      }),
    ).not.toBe(
      canonicalJson({
        a: [
          2,
          1,
        ],
      }),
    );
  });
});

describe('a failed load', () => {
  test('leaves nothing tracked: a later update for that session is not delivered', async () => {
    const rig = await createAcpTestRig({
      script: {
        capabilities: {
          loadSession: true,
        },
        loadRejects: RequestError.resourceNotFound('gone'),
        onPrompt: async (conn) => {
          await conn.sessionUpdate(textChunk('gone', 'stale'));
        },
      },
    });
    const error = await rig.connection
      .loadSession({
        sessionId: 'gone',
        cwd: '/workspace',
      })
      .catch((e: unknown) => e);
    expect(Reflect.get(frameworkCast<object>(error), 'code')).toBe(-32002);
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });
    expect(rig.updates.some((n) => n.sessionId === 'gone')).toBe(false);
    await rig.close();
  });
});

//#endregion

//#region Questions

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

describe('questions', () => {
  test('form elicitation is advertised by default, and withdrawn by config', async () => {
    const bare = await createAcpTestRig();
    expect(bare.calls.initialize[0]?.clientCapabilities?.elicitation).toEqual({
      form: {},
    });
    await bare.close();
    const withdrawn = await createAcpTestRig({
      capabilities: {
        elicitation: false,
      },
    });
    expect(withdrawn.calls.initialize[0]?.clientCapabilities?.elicitation).toBeUndefined();
    await withdrawn.close();
  });

  test("the agent's question reaches the host's handler and its answer the agent", async () => {
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

  test('withdrawn, a question the agent asks anyway never reaches the handler', async () => {
    let asked = 0;
    let answer: acp.CreateElicitationResponse | undefined;
    const rig = await createAcpTestRig({
      capabilities: {
        elicitation: false,
      },
      onElicitation: async () => {
        asked += 1;
        return {
          action: 'decline',
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
    expect(asked).toBe(0);
    expect(answer).toEqual({
      action: 'cancel',
    });
    await rig.close();
  });

  test("each question carries its own JSON-RPC id, and the agent's _meta is left as it sent it", async () => {
    const seen: Array<{
      requestId: string | number | undefined;
      meta: unknown;
    }> = [];
    const rig = await createAcpTestRig({
      onElicitation: async (request, info) => {
        seen.push({
          requestId: info.requestId,
          meta: request._meta,
        });
        return {
          action: 'decline',
        };
      },
      script: {
        onPrompt: async (conn, params) => {
          await conn.createElicitation(FORM_REQUEST(params.sessionId));
          await conn.createElicitation({
            ...FORM_REQUEST(params.sessionId),
            _meta: {
              mine: true,
            },
          });
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.requestId).toBeDefined();
    expect(seen[1]?.requestId).toBeDefined();
    expect(seen[0]?.requestId).not.toBe(seen[1]?.requestId);
    expect(seen[0]?.meta).toBeUndefined();
    expect(seen[1]?.meta).toEqual({
      mine: true,
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

//#region Whose updates count

function subagentAnnounce(parent: string, child: string): acp.SessionNotification {
  return {
    sessionId: parent,
    update: {
      sessionUpdate: 'subagent_update',
      sessionId: child,
      title: 'Explore',
    },
  };
}

describe("subagents' own sessions", () => {
  test("a child session's updates, nested ones too, never reach the step", async () => {
    const rig = await createAcpTestRig({
      script: {
        onPrompt: async (conn, params) => {
          const parent = params.sessionId;
          await conn.sessionUpdate(subagentAnnounce(parent, 'child-1'));
          await conn.sessionUpdate(textChunk('child-1', 'subagent text'));
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
    expect(rig.updates.every((n) => n.sessionId === session.sessionId)).toBe(true);
    expect(JSON.stringify(rig.updates)).not.toContain('subagent text');
    expect(JSON.stringify(rig.updates)).not.toContain('nested text');
    await rig.close();
  });

  test("a child's update sent before its announcement is the child's once it is announced", async () => {
    const children: Array<
      [
        string,
        boolean,
        string,
      ]
    > = [];
    const rig = await createAcpTestRig({
      onChildUpdate: (child) => {
        children.push([
          child.sessionId,
          child.announcement,
          child.update.sessionUpdate,
        ]);
      },
      script: {
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate(textChunk('kid', 'too early'));
          await conn.sessionUpdate(subagentAnnounce(params.sessionId, 'kid'));
          await conn.sessionUpdate(textChunk('kid', 'after'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });
    expect(children).toEqual([
      [
        'kid',
        true,
        'subagent_update',
      ],
      [
        'kid',
        false,
        'agent_message_chunk',
      ],
      [
        'kid',
        false,
        'agent_message_chunk',
      ],
    ]);
    await rig.close();
  });

  test('a grandchild keeps its whole chain however many siblings came after its parent', async () => {
    const lineages: string[][] = [];
    const rig = await createAcpTestRig({
      onChildUpdate: (child) => {
        if (child.sessionId === 'grand' && !child.announcement) {
          lineages.push(child.lineage.map((info) => info.sessionId));
        }
      },
      script: {
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate(subagentAnnounce(params.sessionId, 'parent'));
          await conn.sessionUpdate(subagentAnnounce('parent', 'grand'));
          for (let i = 0; i < 1001; i += 1) {
            await conn.sessionUpdate(subagentAnnounce(params.sessionId, `sib${i}`));
          }
          await conn.sessionUpdate(textChunk('grand', 'still placed'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });
    // Past the cap something is forgotten — never the parent of a kept child, so a
    // grandchild is never placed without its parent, and never leaks to the step.
    expect(lineages.every((lineage) => lineage[0] === 'parent')).toBe(true);
    expect(JSON.stringify(rig.updates)).not.toContain('still placed');
    await rig.close();
  }, 20e3);

  test('past the cap, a child still speaking is never the one forgotten', async () => {
    const heard: string[] = [];
    const rig = await createAcpTestRig({
      onChildUpdate: (child) => {
        if (child.sessionId === 'first' && !child.announcement) {
          heard.push(child.update.sessionUpdate);
        }
      },
      script: {
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate(subagentAnnounce(params.sessionId, 'first'));
          for (let i = 0; i < 1001; i += 1) {
            await conn.sessionUpdate(subagentAnnounce(params.sessionId, `sib${i}`));
            // The oldest child keeps working while its siblings come and go.
            if (i % 100 === 0) {
              await conn.sessionUpdate(textChunk('first', 'still here'));
            }
          }
          await conn.sessionUpdate(textChunk('first', 'last word'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });
    expect(heard.length).toBe(12);
    expect(JSON.stringify(rig.updates)).not.toContain('last word');
    await rig.close();
  }, 20e3);

  test('under the cap, a grandchild that speaks later is placed under its parent', async () => {
    const lineages: string[][] = [];
    const rig = await createAcpTestRig({
      onChildUpdate: (child) => {
        if (child.sessionId === 'grand' && !child.announcement) {
          lineages.push(child.lineage.map((info) => info.sessionId));
        }
      },
      script: {
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate(subagentAnnounce(params.sessionId, 'parent'));
          await conn.sessionUpdate(subagentAnnounce('parent', 'grand'));
          for (let i = 0; i < 50; i += 1) {
            await conn.sessionUpdate(subagentAnnounce(params.sessionId, `sib${i}`));
          }
          await conn.sessionUpdate(textChunk('grand', 'placed'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });
    expect(lineages).toEqual([
      [
        'parent',
        'grand',
      ],
    ]);
    await rig.close();
  });

  test("a child's update sent before its announcement never reaches the step", async () => {
    const rig = await createAcpTestRig({
      script: {
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate(textChunk('early-child', 'too early'));
          await conn.sessionUpdate(subagentAnnounce(params.sessionId, 'early-child'));
          await conn.sessionUpdate(textChunk(params.sessionId, 'the answer'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });
    expect(JSON.stringify(rig.updates)).not.toContain('too early');
    await rig.close();
  });

  test('an update for a session nobody owns is dropped', async () => {
    const rig = await createAcpTestRig({
      script: {
        onPrompt: async (conn) => {
          await conn.sessionUpdate(textChunk('stranger', 'not ours'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });
    expect(JSON.stringify(rig.updates)).not.toContain('not ours');
    await rig.close();
  });

  test("the agent's updates for a session it is still creating are delivered once it is known", async () => {
    const rig = await createAcpTestRig({
      script: {
        beforeNewSessionAnswer: async (conn, sessionId) => {
          await conn.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [
                {
                  name: 'review',
                  description: 'Review the diff',
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
    expect(rig.updates.map((n) => n.update.sessionUpdate)).toEqual([
      'available_commands_update',
    ]);
    expect(session.availableCommands.map((command) => command.name)).toEqual([
      'review',
    ]);
    await rig.close();
  });

  test('a child announced before its parent is known is adopted once it is, and its updates never reach the step', async () => {
    const rig = await createAcpTestRig({
      script: {
        beforeNewSessionAnswer: async (conn, sessionId) => {
          await conn.sessionUpdate(textChunk('early-kid', 'kid before announcement'));
          await conn.sessionUpdate(subagentAnnounce(sessionId, 'early-kid'));
          await conn.sessionUpdate(textChunk('early-kid', 'kid after announcement'));
        },
        onPrompt: async (conn) => {
          await conn.sessionUpdate(textChunk('early-kid', 'kid during the turn'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });
    expect(rig.updates.map((n) => n.update.sessionUpdate)).toEqual([
      'subagent_update',
    ]);
    expect(JSON.stringify(rig.updates)).not.toContain('kid ');
    await rig.close();
  });

  test("codex-acp's draft subagent_spawned announces a child too", async () => {
    const rig = await createAcpTestRig({
      script: {
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate(
            frameworkCast<acp.SessionNotification>({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'subagent_spawned',
                subagentSessionId: 'codex-child',
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
    await session.prompt({
      content: PROMPT,
    });
    expect(JSON.stringify(rig.updates)).not.toContain('worker text');
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
