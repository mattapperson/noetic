/**
 * `pluginConnections()`: a plugin's MCP servers as harness connections.
 *
 * The harness turns use a real stdio server (the fixture in `_helpers.ts`) and
 * a scripted OpenRouter Responses API, so every assertion is on what the
 * model was offered and what came back to it.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mcp } from '@noetic-tools/mcp';
import type {
  ConnectionConfig,
  ConnectionEntries,
  ConnectionProvider,
  ContextLayer,
  ExecuteOptions,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError, SteeringAction } from '@noetic-tools/types';
import { z } from 'zod';
import {
  AgentHarness,
  callModel,
  createInMemoryConnection,
  InMemoryExporter,
} from '../../core/src/index';
import { startFakeOpenRouter } from '../../core/test/_helpers';
import { DiagnosticCode } from '../src/diagnostics';
import { discoverPlugins } from '../src/discovery';
import { buildSubprocessEnv, pluginConnectionName, pluginConnections } from '../src/mcp-client';
import {
  cleanupFixtures,
  FIXTURE_SERVER,
  makePluginRoot,
  manifest,
  mcpConfig,
  ROOT_VAR,
  tempDir,
} from './_helpers';

afterAll(cleanupFixtures);

//#region Fixtures

const SECRET = 'cred-plugin-7c1e';

interface Toolbox {
  root: string;
  dataDir: string;
  connections: ConnectionConfig[];
}

/** The `toolbox` plugin: the fixture server launched with `env`, plus `extra` server entries. */
async function toolbox(
  extra: Record<string, unknown> = {},
  env: Record<string, string> = {},
): Promise<Toolbox> {
  const { root, dataDir } = await makePluginRoot([
    {
      manifest: manifest('toolbox'),
      files: {
        'bin/server.mjs': FIXTURE_SERVER,
      },
      mcp: mcpConfig({
        fixture: {
          type: 'stdio',
          command: 'node',
          args: [
            `${ROOT_VAR}/bin/server.mjs`,
          ],
          env,
        },
        ...extra,
      }),
    },
  ]);
  const { connections } = await pluginConnections(
    await discoverPlugins(
      [
        root,
      ],
      dataDir,
    ),
  );
  return {
    root,
    dataDir,
    connections,
  };
}

interface Turn {
  readonly connections: ConnectionEntries;
  /** The one tool call the model makes. */
  readonly call: {
    readonly name: string;
    readonly arguments: unknown;
  };
  readonly level?: 'harness' | 'turn';
  readonly contextLayers?: ContextLayer[];
}

interface Observed {
  readonly toolsOffered: ReadonlyArray<string>;
  /** What the tool call returned to the model. */
  readonly output: string;
  readonly events: ReadonlyArray<string>;
  readonly spans: ReadonlyArray<string>;
  readonly states: Readonly<Record<string, string>>;
}

/** Ids and times differ run to run; everything else must match. */
function normalize(text: string): string {
  return text
    .replace(
      /"(id|callId|call_id|spanId|traceId|parentSpanId|executionId|turnId|messageId|threadId|instance)":"[^"]*"/g,
      '"$1":"*"',
    )
    .replace(
      /"(time|timestamp|startTime|endTime|duration|durationMs|startedAt|endedAt|latencyMs|completedAt|createdAt|created_at|completed_at)":[^,}]*/g,
      '"$1":*',
    )
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
}

const FunctionOutput = z.object({
  type: z.literal('function_call_output'),
  output: z.unknown(),
});

/** One harness turn in which the model makes `turn.call`, then answers. */
async function runTurn(turn: Turn): Promise<Observed> {
  const model = startFakeOpenRouter((input) => {
    const answered = input.some((entry) => FunctionOutput.safeParse(entry).success);
    if (!answered) {
      return [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: turn.call.name,
          arguments: JSON.stringify(turn.call.arguments),
          status: 'completed',
        },
      ];
    }
    return [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'done',
            annotations: [],
          },
        ],
      },
    ];
  });
  const exporter = new InMemoryExporter();
  const onHarness = (turn.level ?? 'harness') === 'harness';
  const harness = new AgentHarness({
    name: 'plugins',
    params: {},
    ...(onHarness
      ? {
          connections: turn.connections,
        }
      : {}),
    ...(turn.contextLayers
      ? {
          contextLayers: turn.contextLayers,
        }
      : {}),
    agentGraph: callModel({
      id: 'agent',
      model: 'test/model',
    }),
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: model.baseUrl,
    },
    traceExporter: exporter,
  });
  const options: ExecuteOptions = onHarness
    ? {
        threadId: 't',
      }
    : {
        threadId: 't',
        connections: turn.connections,
      };
  const events: string[] = [];
  const stream = harness.getFullStream({
    threadId: 't',
  });
  const reading = (async (): Promise<void> => {
    for await (const event of stream) {
      events.push(normalize(JSON.stringify(event)));
    }
  })();
  try {
    await harness.execute('Use the plugin.', options);
    await harness.getAgentResponse({
      threadId: 't',
    });
    await Bun.sleep(20);
    const second = model.rounds[1]?.input ?? [];
    const outputs = second.flatMap((entry) => {
      const parsed = FunctionOutput.safeParse(entry);
      return parsed.success
        ? [
            String(parsed.data.output),
          ]
        : [];
    });
    return {
      toolsOffered: model.rounds[0]?.tools ?? [],
      output: outputs.join(' | '),
      events: events.filter((event) => !event.includes('connection_changed')),
      spans: exporter.spans
        .map((span) =>
          normalize(
            JSON.stringify({
              name: span.name,
              attributes: Object.fromEntries(span.attributes),
            }),
          ),
        )
        .sort(),
      states: Object.fromEntries(
        harness.getConnectionStatus().map((status) => [
          status.name,
          status.state,
        ]),
      ),
    };
  } finally {
    await harness.close();
    model.stop();
    void reading;
  }
}

/** A connection with no tools that registers {@link SECRET} as a credential, as `mcp({ auth })` would. */
function vault(): ConnectionConfig {
  const inner = createInMemoryConnection({
    name: 'vault',
  });
  const provider: ConnectionProvider = {
    name: 'vault',
    async connect(opts) {
      opts.redact?.(SECRET);
      return inner.connect(opts);
    },
  };
  return {
    provider,
    expose: 'none',
  };
}

async function callsLog(box: Toolbox): Promise<string> {
  try {
    return await readFile(join(box.dataDir, 'toolbox', 'calls.log'), 'utf8');
  } catch {
    return '';
  }
}

const ECHO_CALL = {
  name: 'toolbox_fixture_call',
  arguments: {
    op: 'echo',
    args: {
      text: 'hello',
    },
  },
};

//#endregion

describe('pluginConnectionName', () => {
  test('joins plugin and server with _ and folds what the name rule forbids', () => {
    expect(pluginConnectionName('toolbox', 'fixture')).toBe('toolbox_fixture');
    expect(pluginConnectionName('my.tools', 'api/v2 beta')).toBe('my_tools_api_v2_beta');
    expect(pluginConnectionName('kebab-case', 'srv')).toBe('kebab-case_srv');
  });

  test('gives no name when the plugin name starts with a digit', () => {
    expect(pluginConnectionName('1password', 'vault')).toBeUndefined();
  });
});

describe('pluginConnections', () => {
  test("names each server's entry and exposes it with 'call'", async () => {
    const box = await toolbox();
    expect(
      box.connections.map((entry) => [
        entry.provider.name,
        entry.expose,
      ]),
    ).toEqual([
      [
        'toolbox_fixture',
        'call',
      ],
    ]);
  });

  test('two servers that map to one name fail with CONNECTION_NAME_TAKEN', async () => {
    const http = {
      type: 'streamable-http',
      url: 'https://example.com/mcp',
    };
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('a.b'),
        mcp: mcpConfig({
          c: http,
        }),
      },
      {
        manifest: manifest('a'),
        mcp: mcpConfig({
          b_c: http,
        }),
      },
    ]);
    const found = await discoverPlugins(
      [
        root,
      ],
      dataDir,
    );
    const error = await pluginConnections(found).catch((e: unknown) => e);
    assert(error instanceof NoeticConfigError);
    expect(error.code).toBe('CONNECTION_NAME_TAKEN');
    expect(error.message).toContain("'a_b_c'");
  });

  test('a server whose name breaks the rule is a diagnostic, not an error', async () => {
    const { root, dataDir } = await makePluginRoot([
      {
        manifest: manifest('1password'),
        mcp: mcpConfig({
          vault: {
            type: 'streamable-http',
            url: 'https://example.com/mcp',
          },
        }),
      },
    ]);
    const { connections, diagnostics } = await pluginConnections(
      await discoverPlugins(
        [
          root,
        ],
        dataDir,
      ),
    );
    expect(connections).toHaveLength(0);
    expect(
      diagnostics.map((d) => [
        d.code,
        d.component,
      ]),
    ).toEqual([
      [
        DiagnosticCode.McpServerInvalid,
        'vault',
      ],
    ]);
  });

  test("a stdio server is skipped when its PLUGIN_DATA can't be created; a remote one is kept", async () => {
    const base = await tempDir();
    const { root } = await makePluginRoot([
      {
        manifest: manifest('p'),
        mcp: mcpConfig({
          local: {
            type: 'stdio',
            command: 'node',
          },
          remote: {
            type: 'streamable-http',
            url: 'https://example.com/mcp',
          },
        }),
      },
    ]);
    // A file where the data root should be: no directory can be made under it.
    const blocked = join(base, 'blocked');
    await Bun.write(blocked, 'not a directory');
    const { connections, diagnostics } = await pluginConnections(
      await discoverPlugins(
        [
          root,
        ],
        blocked,
      ),
    );
    expect(connections.map((entry) => entry.provider.name)).toEqual([
      'p_remote',
    ]);
    expect(
      diagnostics.map((d) => [
        d.code,
        d.component,
      ]),
    ).toEqual([
      [
        DiagnosticCode.McpConnectFailed,
        'local',
      ],
    ]);
    expect(diagnostics[0]?.detail).toContain('§9.1');
  });
});

describe('plugin servers in a harness turn', () => {
  test('a failing server is an unavailable connection; the working one still serves the turn', async () => {
    const box = await toolbox({
      missing: {
        type: 'stdio',
        command: 'noetic-agent-plugins-no-such-executable',
      },
    });
    expect(box.connections.map((entry) => entry.provider.name)).toEqual([
      'toolbox_fixture',
      'toolbox_missing',
    ]);
    const seen = await runTurn({
      connections: box.connections,
      call: ECHO_CALL,
    });
    expect(seen.states).toEqual({
      toolbox_fixture: 'ready',
      toolbox_missing: 'unavailable',
    });
    expect(seen.toolsOffered).toEqual([
      'toolbox_fixture_ops',
      'toolbox_fixture_call',
    ]);
    expect(seen.output).toContain('hello');
  }, 30_000);

  test('the connection policy denies an operation before it reaches the server', async () => {
    const box = await toolbox();
    const seen = await runTurn({
      connections: box.connections.map((entry) => ({
        ...entry,
        policy: {
          deny: [
            'echo',
          ],
        },
      })),
      call: ECHO_CALL,
    });
    expect(seen.output).toContain('denied by the connection policy');
    expect(await callsLog(box)).not.toContain('echo');
  }, 30_000);

  test('a beforeToolCall layer sees and can refuse the plugin tool', async () => {
    const box = await toolbox();
    const gated: string[] = [];
    const gate = frameworkCast<ContextLayer>({
      id: 'gate',
      slot: 0,
      hooks: {
        beforeToolCall: async (params: { toolName: string }) => {
          gated.push(params.toolName);
          return {
            decision: {
              action: SteeringAction.Deny,
              guidance: 'not now',
            },
          };
        },
      },
    });
    const seen = await runTurn({
      connections: box.connections,
      call: ECHO_CALL,
      contextLayers: [
        gate,
      ],
    });
    expect(gated).toEqual([
      'toolbox_fixture_call',
    ]);
    expect(seen.output).not.toContain('hello');
    expect(await callsLog(box)).not.toContain('echo');
  }, 30_000);

  test('a credential the harness holds is scrubbed from plugin output', async () => {
    // The server prints its CONFIG variable, so the credential comes from the
    // plugin, never from the model's arguments.
    const box = await toolbox(
      {},
      {
        CONFIG: SECRET,
      },
    );
    const seen = await runTurn({
      connections: [
        vault(),
        ...box.connections,
      ],
      call: {
        name: 'toolbox_fixture_call',
        arguments: {
          op: 'echo_env',
        },
      },
    });
    expect(await callsLog(box)).toContain('echo_env');
    expect(seen.output).toContain('"config\\":\\"<redacted>');
    for (const text of [
      seen.output,
      ...seen.events,
      ...seen.spans,
    ]) {
      expect(text).not.toContain(SECRET);
    }
  }, 30_000);

  test('the idempotency key comes from the execution and tool call, so a replay sends the same one', async () => {
    const box = await toolbox();
    const seen = await runTurn({
      connections: box.connections,
      call: {
        name: 'toolbox_fixture_call',
        arguments: {
          op: 'key',
        },
      },
    });
    // `<executionId>:tool:<callId>`, the model's own call id: nothing random,
    // so a resumed turn that replays the call sends the key the server
    // already saw.
    const key = z
      .object({
        content: z.array(
          z.object({
            text: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(seen.output)).content[0]?.text;
    expect(key).toMatch(/^[0-9a-f-]{36}:tool:call_1$/);
  }, 30_000);
});

describe('a plugin server and the same server through mcp()', () => {
  test('give byte-identical tools, results, events and spans, at the harness and the turn', async () => {
    const box = await toolbox();
    const root = join(box.root, 'toolbox');
    const pluginData = join(box.dataDir, 'toolbox');
    const direct: ConnectionConfig = {
      provider: mcp({
        name: 'toolbox_fixture',
        command: 'node',
        args: [
          join(root, 'bin/server.mjs'),
        ],
        env: Object.entries(
          buildSubprocessEnv({
            server: {
              key: 'toolbox/fixture',
              type: 'stdio',
              command: 'node',
              args: [],
              env: {},
              cwd: root,
            },
            pluginRoot: root,
            pluginData,
          }),
        ).map(([name, value]) => ({
          name,
          value,
        })),
        cwd: root,
      }),
      expose: 'call',
    };
    const call = {
      name: 'toolbox_fixture_call',
      arguments: {
        op: 'echo_env',
        args: {
          prefix: 'ENV=',
        },
      },
    };
    for (const level of [
      'harness',
      'turn',
    ] as const) {
      const fromPlugin = await runTurn({
        connections: box.connections,
        call,
        level,
      });
      const fromMcp = await runTurn({
        connections: [
          direct,
        ],
        call,
        level,
      });
      expect(fromPlugin.output).toContain(pluginData);
      expect(fromPlugin.toolsOffered).toEqual([
        'toolbox_fixture_ops',
        'toolbox_fixture_call',
      ]);
      expect(fromPlugin).toEqual(fromMcp);
    }
  }, 60_000);
});
