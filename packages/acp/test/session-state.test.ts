/**
 * Current ACP session updates and session state over the real JSON-RPC wire:
 * `usage_update` and the other post-0.4 variants are accepted (#96), usage is
 * kept apart from billed tokens, model choice goes through the `model` config
 * option, and a loaded session keeps the modes and config options its
 * `session/load` answer advertised (#99).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type * as acp from '@agentclientprotocol/sdk';
import { isAcpCapabilityError } from '@noetic-tools/types';
import { rawInputRecord } from '../src/permission-channel';
import { createAcpTestRig, textChunk } from './_helpers';

const TEXT_PROMPT: acp.ContentBlock[] = [
  {
    type: 'text',
    text: 'hello',
  },
];

const MODES: acp.SessionModeState = {
  currentModeId: 'auto',
  availableModes: [
    {
      id: 'auto',
      name: 'Auto',
    },
    {
      id: 'read-only',
      name: 'Read only',
    },
  ],
};

const MODEL_OPTION: acp.SessionConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'gpt-5.5',
  options: [
    {
      value: 'gpt-5.5',
      name: 'GPT-5.5',
    },
    {
      value: 'gpt-6-astra',
      name: 'GPT-6 Astra',
    },
  ],
};

/** The client logs every notification it cannot parse; none may be logged. */
let consoleError: ReturnType<typeof spyOn>;
beforeEach(() => {
  consoleError = spyOn(console, 'error');
});
afterEach(() => {
  consoleError.mockRestore();
});

function loggedProtocolErrors(): unknown[][] {
  return consoleError.mock.calls.filter((args: unknown[]) =>
    args.some((arg) => String(arg).includes('notification')),
  );
}

describe('current session updates (#96)', () => {
  test('accepts a Codex usage_update and hands it to the host verbatim', async () => {
    const rig = await createAcpTestRig({
      script: {
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'usage_update',
              used: 22001,
              size: 258400,
            },
          });
          await conn.sessionUpdate(textChunk(params.sessionId, 'done'));
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });

    const result = await session.prompt({
      content: TEXT_PROMPT,
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toBe('done');
    const usage = rig.updates.find((n) => n.update.sessionUpdate === 'usage_update');
    expect(usage?.update).toEqual({
      sessionUpdate: 'usage_update',
      used: 22001,
      size: 258400,
    });
    // Context occupancy is not billed usage: it never becomes token usage.
    expect(result.usage).toBeUndefined();
    expect(result.reportedUsage).toBeUndefined();
    expect(loggedProtocolErrors()).toEqual([]);

    await rig.close();
  });

  test('accepts session_info_update and config_option_update, and tracks config options', async () => {
    const effort: acp.SessionConfigOption = {
      id: 'reasoning_effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        {
          value: 'high',
          name: 'High',
        },
      ],
    };
    const rig = await createAcpTestRig({
      script: {
        configOptions: [
          MODEL_OPTION,
        ],
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'session_info_update',
              title: 'Fix the build',
            },
          });
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'config_option_update',
              configOptions: [
                MODEL_OPTION,
                effort,
              ],
            },
          });
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    expect(session.configOptions).toEqual([
      MODEL_OPTION,
    ]);

    await session.prompt({
      content: TEXT_PROMPT,
    });

    expect(rig.updates.map((n) => n.update.sessionUpdate)).toEqual([
      'session_info_update',
      'config_option_update',
    ]);
    expect(session.configOptions).toEqual([
      MODEL_OPTION,
      effort,
    ]);
    expect(loggedProtocolErrors()).toEqual([]);

    await rig.close();
  });

  test("keeps the prompt answer's usage as reportedUsage, apart from billed usage", async () => {
    const rig = await createAcpTestRig({
      script: {
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });

    const result = await session.prompt({
      content: TEXT_PROMPT,
    });

    expect(result.reportedUsage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    });
    expect(result.usage).toBeUndefined();

    await rig.close();
  });
});

describe('model selection', () => {
  test('setModel selects the advertised model config option', async () => {
    const rig = await createAcpTestRig({
      script: {
        configOptions: [
          MODEL_OPTION,
        ],
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });

    await session.setModel('gpt-6-astra');

    expect(rig.calls.setConfigOption).toEqual([
      {
        sessionId: 'session-1',
        configId: 'model',
        value: 'gpt-6-astra',
      },
    ]);
    const model = session.configOptions?.find((option) => option.id === 'model');
    expect(model?.currentValue).toBe('gpt-6-astra');

    await rig.close();
  });

  test('setModel throws AcpCapabilityError when no model option is advertised', async () => {
    const rig = await createAcpTestRig();
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });

    const error = await session.setModel('gpt-5.5').then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isAcpCapabilityError(error)).toBe(true);
    expect(rig.calls.setConfigOption).toHaveLength(0);

    await rig.close();
  });
});

describe('loaded sessions (#99)', () => {
  test('keep the modes and config options session/load advertised, and select an advertised mode', async () => {
    const rig = await createAcpTestRig({
      script: {
        capabilities: {
          loadSession: true,
        },
        loadResponse: {
          modes: MODES,
          configOptions: [
            MODEL_OPTION,
          ],
        },
      },
    });

    const session = await rig.connection.loadSession({
      sessionId: 'saved-session',
      cwd: '/workspace',
    });

    expect(session.modes).toEqual(MODES);
    expect(session.configOptions).toEqual([
      MODEL_OPTION,
    ]);
    await session.setMode('read-only');
    expect(rig.calls.setMode).toEqual([
      {
        sessionId: 'saved-session',
        modeId: 'read-only',
      },
    ]);
    await session.setModel('gpt-6-astra');
    expect(rig.calls.setConfigOption[0]?.value).toBe('gpt-6-astra');

    await rig.close();
  });

  test('still refuse mode selection when the load advertised no modes', async () => {
    const rig = await createAcpTestRig({
      script: {
        capabilities: {
          loadSession: true,
        },
      },
    });

    const session = await rig.connection.loadSession({
      sessionId: 'saved-session',
      cwd: '/workspace',
    });
    const error = await session.setMode('read-only').then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(session.modes).toBeUndefined();
    expect(isAcpCapabilityError(error)).toBe(true);
    expect(rig.calls.setMode).toHaveLength(0);

    await rig.close();
  });

  test('track current_mode_update on the session mode state', async () => {
    const rig = await createAcpTestRig({
      script: {
        capabilities: {
          loadSession: true,
        },
        loadResponse: {
          modes: MODES,
        },
        onPrompt: async (conn, params) => {
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'current_mode_update',
              currentModeId: 'read-only',
            },
          });
        },
      },
    });
    const session = await rig.connection.loadSession({
      sessionId: 'saved-session',
      cwd: '/workspace',
    });

    const result = await session.prompt({
      content: TEXT_PROMPT,
    });

    expect(result.currentModeId).toBe('read-only');
    expect(session.modes?.currentModeId).toBe('read-only');

    await rig.close();
  });
});

describe('rawInputRecord', () => {
  test('keeps an object, wraps a scalar or array, and drops nothing-values', () => {
    expect(
      rawInputRecord({
        path: '/a',
      }),
    ).toEqual({
      path: '/a',
    });
    expect(rawInputRecord('ls -la')).toEqual({
      value: 'ls -la',
    });
    expect(
      rawInputRecord([
        1,
        2,
      ]),
    ).toEqual({
      value: [
        1,
        2,
      ],
    });
    expect(rawInputRecord(null)).toBeUndefined();
    expect(rawInputRecord(undefined)).toBeUndefined();
  });
});
