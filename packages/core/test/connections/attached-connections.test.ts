/**
 * Connections attached at every level (spec 35 § Attaching connections): the
 * harness (record and list), the turn (`execute(…, { connections })`) and a
 * step (`tools: [entry]`), plus `connectionTools()` picks and `expose: 'call'`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type {
  ConnectionProvider,
  ContextData,
  NoeticConfigError,
  StepCallModel,
  StepToolEntry,
  Tool,
} from '@noetic-tools/types';
import {
  defineProfile,
  frameworkCast,
  isNoeticConfigError,
  isNoeticError,
} from '@noetic-tools/types';
import { z } from 'zod';
import { spawn } from '../../src/builders/spawn-builder';
import { callModel } from '../../src/builders/step-builders';
import { namedEntries } from '../../src/connections/entries';
import { connection } from '../../src/connections/handle';
import type {
  InMemoryConnectionOptions,
  InMemoryConnectionProvider,
} from '../../src/connections/in-memory-connection';
import { createInMemoryConnection } from '../../src/connections/in-memory-connection';
import { buildConnectionTools, connectionTools } from '../../src/connections/model-tools';
import type { ConnectionRuntime } from '../../src/connections/registry';
import { createConnectionRuntime } from '../../src/connections/registry';
import { offeredTools, splitStepTools, withOffered } from '../../src/connections/step-tools';
import { connectionViewLayers } from '../../src/connections/views';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryArtifactStore } from '../../src/runtime/in-memory-artifact-store';
import { harnessInternal, setHarnessInternals } from '../../src/util/harness-internals';
import type { FakeOpenRouter } from '../_helpers';
import { makeMockContext, makeStorage, startFakeOpenRouter } from '../_helpers';

//#region Fixtures

const servers: FakeOpenRouter[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

function phoneOptions(name?: string): InMemoryConnectionOptions {
  return {
    ...(name === undefined
      ? {}
      : {
          name,
        }),
    instance: 'phone-1',
    operations: {
      ping: {
        description: 'Ping.',
        inputSchema: {
          type: 'object',
        },
        run: () => 'pong',
      },
      reboot: {
        effects: true,
        inputSchema: {
          type: 'object',
        },
        run: () => 'rebooted',
      },
    },
  };
}

function phone(name: string | undefined = 'phone'): InMemoryConnectionProvider {
  return createInMemoryConnection(phoneOptions(name));
}

function uiDevice(name: string): InMemoryConnectionProvider {
  return createInMemoryConnection({
    name,
    profiles: {
      ui: '1.1.0',
    },
    operations: {
      'ui.tap': {
        profile: 'ui',
        eager: true,
        inputSchema: {
          type: 'object',
        },
        run: () => `tapped ${name}`,
      },
      'ui.scroll': {
        profile: 'ui',
        inputSchema: {
          type: 'object',
        },
        run: () => 'scrolled',
      },
      'ui.swipe': {
        profile: 'ui',
        inputSchema: {
          type: 'object',
        },
        run: () => 'swiped',
      },
    },
  });
}

/** A model that calls `tool` once, then answers with every tool output it saw. */
function callsOnce(tool: string, args: unknown = {}): (input: unknown[]) => unknown[] {
  return (input) => {
    const outputs = input.flatMap((entry) => {
      const parsed = z
        .object({
          type: z.literal('function_call_output'),
          output: z.unknown(),
        })
        .safeParse(entry);
      return parsed.success
        ? [
            String(parsed.data.output),
          ]
        : [];
    });
    if (outputs.length === 0) {
      return [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: tool,
          arguments: JSON.stringify(args),
          status: 'completed',
        },
      ];
    }
    return [
      {
        type: 'message',
        id: `msg_${crypto.randomUUID()}`,
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: `saw ${outputs.join(' | ')}`,
            annotations: [],
          },
        ],
      },
    ];
  };
}

function fakeModel(reply: (input: unknown[]) => unknown[]): FakeOpenRouter {
  const server = startFakeOpenRouter(reply);
  servers.push(server);
  return server;
}

function harnessWith(
  server: FakeOpenRouter,
  opts: Omit<
    ConstructorParameters<typeof AgentHarness>[0],
    'name' | 'params' | 'callModelDefaults'
  >,
): AgentHarness {
  return new AgentHarness({
    name: 'attach',
    params: {},
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: server.baseUrl,
    },
    ...opts,
  });
}

function agent(tools?: StepToolEntry[]): StepCallModel<ContextData, string, string> {
  return callModel<ContextData, string, string>({
    id: 'agent',
    model: 'test/model',
    ...(tools === undefined
      ? {}
      : {
          tools,
        }),
  });
}

function registryOf(harness: AgentHarness): ConnectionRuntime {
  const registry = harnessInternal<ConnectionRuntime>(harness, 'connectionRegistry');
  if (!registry) {
    throw new Error('no registry');
  }
  return registry;
}

function configError(fn: () => unknown): NoeticConfigError {
  try {
    fn();
  } catch (e) {
    if (isNoeticConfigError(e)) {
      return e;
    }
    throw e;
  }
  throw new Error('expected a NoeticConfigError');
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

function codeOf(error: unknown): string | undefined {
  return isNoeticConfigError(error) ? error.code : undefined;
}

async function runtimeOver(
  connections: Record<
    string,
    | ConnectionProvider
    | {
        provider: ConnectionProvider;
        expose: 'call';
      }
  >,
): Promise<ConnectionRuntime> {
  const runtime = createConnectionRuntime({
    connections,
    storage: makeStorage(),
    artifacts: createInMemoryArtifactStore(),
  });
  await runtime.start();
  return runtime;
}

function names(tools: ReadonlyArray<Tool> | undefined): string[] {
  return (tools ?? []).map((t) => t.name).sort();
}

function toolNamed(tools: ReadonlyArray<Tool> | undefined, name: string): Tool {
  const tool = tools?.find((t) => t.name === name);
  assert(tool, `no tool ${name}`);
  return tool;
}

/** Runs a connection tool as a model call would, against `runtime`. */
async function runTool(
  runtime: ConnectionRuntime,
  tool: Tool,
  args: Record<string, unknown>,
): Promise<unknown> {
  const harness = frameworkCast<Record<string, unknown>>({});
  setHarnessInternals(harness, {
    connectionRegistry: runtime,
  });
  return await tool.execute(
    args,
    frameworkCast({
      ctx: makeMockContext(),
      harness,
    }),
  );
}

/** The error kind a refused run throws. */
async function deniedRun(
  runtime: ConnectionRuntime,
  tool: Tool,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const error = await rejection(runTool(runtime, tool, args));
  return isNoeticError(error) ? error.noeticError.kind : undefined;
}

//#endregion

describe('naming entries', () => {
  test('a record and a list of named entries name the same connections', () => {
    const provider = phone();
    expect(
      namedEntries(
        {
          phone: provider,
        },
        'here',
      ).map((e) => e.name),
    ).toEqual([
      'phone',
    ]);
    expect(
      namedEntries(
        [
          provider,
          {
            provider,
          },
        ],
        'here',
      ).map((e) => e.name),
    ).toEqual([
      'phone',
    ]);
  });

  test('a record key that disagrees with the provider name is CONNECTION_INVALID', () => {
    expect(
      configError(() =>
        namedEntries(
          {
            mobile: phone('phone'),
          },
          'here',
        ),
      ).code,
    ).toBe('CONNECTION_INVALID');
  });

  test('a list entry with no name is CONNECTION_INVALID', () => {
    expect(
      configError(() =>
        namedEntries(
          [
            createInMemoryConnection(phoneOptions()),
          ],
          'here',
        ),
      ).code,
    ).toBe('CONNECTION_INVALID');
  });

  test('one name for two providers is CONNECTION_NAME_TAKEN', () => {
    expect(
      configError(() =>
        namedEntries(
          [
            phone(),
            phone(),
          ],
          'here',
        ),
      ).code,
    ).toBe('CONNECTION_NAME_TAKEN');
    const provider = phone();
    expect(
      configError(() =>
        namedEntries(
          [
            provider,
            {
              provider,
              policy: {
                deny: [
                  'reboot',
                ],
              },
            },
          ],
          'here',
        ),
      ).code,
    ).toBe('CONNECTION_NAME_TAKEN');
  });

  test('the harness refuses a record key its provider name contradicts', () => {
    const error = configError(
      () =>
        new AgentHarness({
          name: 'h',
          params: {},
          connections: {
            mobile: phone('phone'),
          },
        }),
    );
    expect(error.code).toBe('CONNECTION_INVALID');
  });
});

describe('harness entries', () => {
  test('a list of named entries attaches them for the harness life', async () => {
    const server = fakeModel(callsOnce('phone_ping'));
    const provider = phone();
    const harness = harnessWith(server, {
      connections: [
        provider,
      ],
      agentGraph: agent(),
    });
    await harness.execute('ping it');
    const response = await harness.getAgentResponse();
    expect(response.text).toBe('saw pong');
    expect(server.rounds[0]?.tools).toContain('phone_ping');
    expect(provider.connection.calls.map((c) => c.op)).toEqual([
      'ping',
    ]);
    expect(harness.getConnectionStatus().map((s) => s.name)).toEqual([
      'phone',
    ]);
    await harness.close();
  });
});

describe('turn entries', () => {
  test('connect at the turn start, are offered to the model, and are released when it ends', async () => {
    const server = fakeModel(callsOnce('phone_ping'));
    const provider = phone();
    const harness = harnessWith(server, {
      agentGraph: agent(),
    });
    await harness.execute('ping it', {
      connections: [
        provider,
      ],
    });
    const response = await harness.getAgentResponse();
    expect(response.text).toBe('saw pong');
    expect(server.rounds[0]?.tools).toContain('phone_ping');
    expect(provider.connection.calls.map((c) => c.op)).toEqual([
      'ping',
    ]);
    expect(provider.connection.released).toBe(true);
    expect(registryOf(harness).visibleNames()).toEqual([]);
    expect(harness.getConnectionStatus()).toEqual([]);
    await harness.close();
  });

  test('a later turn without them is not offered their tools', async () => {
    const server = fakeModel(() => [
      {
        type: 'message',
        id: `msg_${crypto.randomUUID()}`,
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'ok',
            annotations: [],
          },
        ],
      },
    ]);
    const harness = harnessWith(server, {
      agentGraph: agent(),
    });
    await harness.execute('one', {
      connections: {
        phone: phone(),
      },
    });
    await harness.getAgentResponse();
    await harness.execute('two');
    await harness.getAgentResponse();
    expect(server.rounds[0]?.tools).toContain('phone_ping');
    expect(server.rounds[1]?.tools ?? []).not.toContain('phone_ping');
    await harness.close();
  });

  test('the harness entry itself is the same connection, connected once', async () => {
    const server = fakeModel(callsOnce('phone_ping'));
    const provider = phone();
    const harness = harnessWith(server, {
      connections: [
        provider,
      ],
      agentGraph: agent(),
    });
    await harness.execute('ping', {
      connections: [
        provider,
      ],
    });
    await harness.getAgentResponse();
    expect(provider.connects).toBe(1);
    expect(provider.connection.released).toBe(false);
    await harness.close();
  });

  test('a harness name given to another provider fails the turn with CONNECTION_NAME_TAKEN', async () => {
    const registry = createConnectionRuntime({
      connections: [
        phone(),
      ],
      storage: makeStorage(),
      artifacts: createInMemoryArtifactStore(),
    });
    const root = makeMockContext();
    const error = await rejection(
      registry.attach(root, [
        {
          name: 'phone',
          config: {
            provider: phone(),
          },
          scope: 'turn',
          where: 'execute() connections',
        },
      ]),
    );
    expect(codeOf(error)).toBe('CONNECTION_NAME_TAKEN');
  });

  test('a turn entry with a pool is CONNECTION_INVALID', async () => {
    const registry = createConnectionRuntime({
      storage: makeStorage(),
      artifacts: createInMemoryArtifactStore(),
    });
    const error = await rejection(
      registry.attach(makeMockContext(), [
        {
          name: 'phone',
          config: {
            provider: phone(),
            pool: {
              max: 1,
            },
          },
          scope: 'turn',
          where: 'execute() connections',
        },
      ]),
    );
    expect(codeOf(error)).toBe('CONNECTION_INVALID');
  });

  test('a resumed run finds a turn entry by its name and execution id', async () => {
    const registry = createConnectionRuntime({
      storage: makeStorage(),
      artifacts: createInMemoryArtifactStore(),
    });
    const root = makeMockContext();
    await registry.attach(root, [
      {
        name: 'phone',
        config: {
          provider: phone(),
        },
        scope: 'turn',
        where: 'turn',
      },
    ]);
    const recorded = registry.current('phone', root.id)?.identity;
    assert(recorded);
    const decision = await registry.checkResume({
      executionId: root.id,
      name: 'phone',
      recorded,
      signal: new AbortController().signal,
    });
    expect(decision).toBe('keep');
    await registry.detach(root.id);
    expect(registry.visibleNames(root.id)).toEqual([]);
  });

  test('a hold keeps them attached past the turn until it is let go', async () => {
    const registry = createConnectionRuntime({
      storage: makeStorage(),
      artifacts: createInMemoryArtifactStore(),
    });
    const provider = phone();
    const root = makeMockContext();
    await registry.attach(root, [
      {
        name: 'phone',
        config: {
          provider,
        },
        scope: 'turn',
        where: 'turn',
      },
    ]);
    const letGo = registry.hold(root.id);
    await registry.detach(root.id);
    expect(provider.connection.released).toBe(false);
    expect(registry.current('phone', root.id)).toBeDefined();
    letGo();
    await Bun.sleep(1);
    expect(provider.connection.released).toBe(true);
  });

  test('a trigger cannot name a connection only a turn attaches', () => {
    const error = configError(
      () =>
        new AgentHarness({
          name: 'h',
          params: {},
          triggers: [
            {
              id: 't',
              connection: 'phone',
              event: 'rang',
              input: () => 'rang',
            },
          ],
        }),
    );
    expect(error.code).toBe('CONNECTION_UNKNOWN');
  });

  test('spawned children see the root turn connections', async () => {
    const server = fakeModel(callsOnce('phone_ping'));
    const provider = phone();
    const harness = harnessWith(server, {
      agentGraph: spawn<ContextData, string, string>({
        id: 'child',
        child: agent(),
      }),
    });
    await harness.execute('ping', {
      connections: [
        provider,
      ],
    });
    await harness.getAgentResponse();
    expect(server.rounds[0]?.tools).toContain('phone_ping');
    expect(provider.connection.calls.map((c) => c.op)).toEqual([
      'ping',
    ]);
    await harness.close();
  });
});

describe('step entries', () => {
  test('are offered only by the step that lists them', async () => {
    const server = fakeModel(callsOnce('phone_ping'));
    const provider = phone();
    const harness = harnessWith(server, {
      agentGraph: [
        callModel<ContextData, string, string>({
          id: 'with-phone',
          model: 'test/model',
          tools: [
            provider,
          ],
        }),
        callModel<ContextData, string, string>({
          id: 'without',
          model: 'test/model',
        }),
      ],
    });
    await harness.execute('ping');
    await harness.getAgentResponse();
    expect(provider.connection.calls.map((c) => c.op)).toEqual([
      'ping',
    ]);
    const allowed = (round: number): string[] =>
      z
        .object({
          tools: z.array(
            z.object({
              name: z.string(),
            }),
          ),
        })
        .parse(server.rounds[round]?.toolChoice)
        .tools.map((t) => t.name);
    expect(allowed(0)).toEqual([
      'phone_ping',
      'phone_reboot',
    ]);
    // The other step may use none of the turn's tools, so it is sent none.
    expect(server.rounds.at(-1)?.tools).toEqual([]);
    expect(provider.connection.released).toBe(true);
    await harness.close();
  });

  test('a step entry reached through a handle is CONNECTION_UNKNOWN', async () => {
    const registry = createConnectionRuntime({
      storage: makeStorage(),
      artifacts: createInMemoryArtifactStore(),
    });
    const root = makeMockContext();
    await registry.attach(root, [
      {
        name: 'phone',
        config: {
          provider: phone(),
        },
        scope: 'step',
        where: 'step',
      },
    ]);
    const scope = {
      executionId: root.id,
      threadId: root.threadId,
      scopeKey: root.id,
      signal: new AbortController().signal,
    };
    const error = await rejection(
      registry.resolve({
        name: 'phone',
        scope,
        ctx: root,
      }),
    );
    expect(codeOf(error)).toBe('CONNECTION_UNKNOWN');
    const resolved = await registry.resolve({
      name: 'phone',
      scope,
      ctx: root,
      caller: 'model',
    });
    expect(resolved.name).toBe('phone');
  });

  test('a step entry with a pool is CONNECTION_INVALID', async () => {
    const server = fakeModel(callsOnce('phone_ping'));
    const harness = harnessWith(server, {});
    const error = await rejection(
      harness.run(
        agent([
          {
            provider: phone(),
            pool: {
              max: 1,
            },
          },
        ]),
        'x',
        harness.createContext(),
      ),
    );
    expect(codeOf(error)).toBe('CONNECTION_INVALID');
    await harness.close();
  });

  test('a function-form tools that returns an unattached entry is CONNECTION_INVALID', async () => {
    const server = fakeModel(callsOnce('phone_ping'));
    const harness = harnessWith(server, {});
    const lazy = callModel<ContextData, string, string>({
      id: 'lazy',
      model: 'test/model',
      tools: () => [
        phone(),
      ],
    });
    const ctx = harness.createContext();
    const error = await rejection(harness.run(lazy, 'x', ctx));
    expect(codeOf(error)).toBe('CONNECTION_INVALID');
    expect(ctx.itemLog.items).toEqual([]);
    await harness.close();
  });

  test('a function-form tools may list a connection the harness attached', async () => {
    const server = fakeModel(callsOnce('phone_ping'));
    const provider = phone();
    const harness = harnessWith(server, {
      connections: [
        provider,
      ],
    });
    const lazy = callModel<ContextData, string, string>({
      id: 'lazy',
      model: 'test/model',
      tools: () => [
        provider,
      ],
    });
    const ctx = harness.createContext();
    const output = await harness.run(lazy, 'x', ctx);
    expect(output).toBe('saw pong');
    expect(ctx.itemLog.items.some((item) => item.type === 'function_call_output')).toBe(true);
    await harness.close();
  });

  test('toolChoice naming a tool the step is not offered is UNKNOWN_TOOL_CHOICE at the turn start', async () => {
    const server = fakeModel(callsOnce('phone_ping'));
    const forced = callModel<ContextData, string, string>({
      id: 'forced',
      model: 'test/model',
      tools: [
        phone(),
      ],
      toolChoice: {
        tool: 'phone_missing',
      },
    });
    const harness = harnessWith(server, {});
    const error = await rejection(harness.run(forced, 'x', harness.createContext()));
    expect(codeOf(error)).toBe('UNKNOWN_TOOL_CHOICE');
    expect(server.rounds).toHaveLength(0);
    await harness.close();
  });

  test('toolChoice naming a connection tool the step lists is sent forced', async () => {
    const server = fakeModel(callsOnce('phone_ping'));
    const forced = callModel<ContextData, string, string>({
      id: 'forced',
      model: 'test/model',
      tools: [
        phone(),
      ],
      toolChoice: {
        tool: 'phone_ping',
      },
    });
    const harness = harnessWith(server, {});
    const ctx = harness.createContext();
    await harness.run(forced, 'x', ctx);
    expect(server.rounds[0]?.toolChoice).toMatchObject({
      type: 'function',
      name: 'phone_ping',
    });
    expect(ctx.itemLog.items.some((item) => item.type === 'function_call')).toBe(true);
    await harness.close();
  });
});

describe('connectionTools() picks', () => {
  test('uses the harness names, narrowed to ops', async () => {
    const runtime = await runtimeOver({
      phone: phone(),
    });
    const unified = buildConnectionTools(runtime);
    const offered = offeredTools(
      unified,
      splitStepTools([
        connectionTools(connection('phone'), {
          ops: [
            'ping',
          ],
        }),
      ]),
      {
        runtime,
        rootId: 'r',
      },
    );
    expect(names(offered)).toEqual([
      'phone_ping',
    ]);
    await runtime.close();
  });

  test('a merged profile tool keeps its name but reaches only the picked targets', async () => {
    const runtime = await runtimeOver({
      app: uiDevice('app'),
      web: uiDevice('web'),
    });
    const unified = buildConnectionTools(runtime);
    expect(names(unified)).toEqual([
      'app_call',
      'app_ops',
      'ui_tap',
      'web_call',
      'web_ops',
    ]);
    const offered = offeredTools(
      unified,
      splitStepTools([
        connectionTools(connection('app'), {
          ops: [
            'ui.tap',
          ],
        }),
      ]),
      {
        runtime,
        rootId: 'r',
      },
    );
    expect(names(offered)).toEqual([
      'ui_tap',
    ]);
    const tap = toolNamed(offered, 'ui_tap');
    expect(tap.inputJsonSchema).toMatchObject({
      properties: {
        target: {
          enum: [
            'app',
          ],
        },
      },
    });
    expect(
      await runTool(runtime, tap, {
        target: 'app',
      }),
    ).toBe('tapped app');
    expect(
      await deniedRun(runtime, tap, {
        target: 'web',
      }),
    ).toBe('steering_denied');
    await runtime.close();
  });

  test('cuts <name>_ops and <name>_call to the picked operations', async () => {
    const runtime = await runtimeOver({
      app: uiDevice('app'),
    });
    const unified = buildConnectionTools(runtime);
    const pick = (ops: string[]): Tool[] =>
      offeredTools(
        unified,
        splitStepTools([
          connectionTools(connection('app'), {
            ops,
          }),
        ]),
        {
          runtime,
          rootId: 'r',
        },
      ) ?? [];
    expect(
      names(
        pick([
          'ui.tap',
        ]),
      ),
    ).toEqual([
      'app_ui_tap',
    ]);
    const scroll = pick([
      'ui.scroll',
    ]);
    expect(names(scroll)).toEqual([
      'app_call',
      'app_ops',
    ]);
    expect(await runTool(runtime, toolNamed(scroll, 'app_ops'), {})).toMatchObject({
      operations: [
        {
          op: 'ui.scroll',
        },
      ],
    });
    expect(
      await runTool(runtime, toolNamed(scroll, 'app_call'), {
        op: 'ui.scroll',
      }),
    ).toBe('scrolled');
    expect(
      await deniedRun(runtime, toolNamed(scroll, 'app_call'), {
        op: 'ui.swipe',
      }),
    ).toBe('steering_denied');
    const all = pick([
      'ui.*',
    ]);
    expect(names(all)).toEqual([
      'app_call',
      'app_ops',
      'app_ui_tap',
    ]);
    expect(toolNamed(all, 'app_call')).toBe(toolNamed(unified, 'app_call'));
    await runtime.close();
  });

  test('merged ops and call refuse a target the step did not pick', async () => {
    const runtime = await runtimeOver({
      a: {
        provider: phone('a'),
        expose: 'call',
      },
      secretdb: {
        provider: phone('secretdb'),
        expose: 'call',
      },
    });
    const unified = buildConnectionTools(runtime);
    const offered = offeredTools(
      unified,
      splitStepTools([
        connectionTools('a'),
      ]),
      {
        runtime,
        rootId: 'r',
      },
    );
    expect(names(offered)).toEqual([
      'call',
      'ops',
    ]);
    const call = toolNamed(offered, 'call');
    expect(call.inputJsonSchema).toMatchObject({
      properties: {
        target: {
          enum: [
            'a',
          ],
        },
      },
    });
    expect(
      await runTool(runtime, call, {
        target: 'a',
        op: 'ping',
      }),
    ).toBe('pong');
    expect(
      await deniedRun(runtime, call, {
        target: 'secretdb',
        op: 'reboot',
      }),
    ).toBe('steering_denied');
    expect(
      await deniedRun(runtime, toolNamed(offered, 'ops'), {
        target: 'secretdb',
      }),
    ).toBe('steering_denied');
    expect(
      await deniedRun(runtime, call, {
        target: 'secretdb',
        read: 'status',
      }),
    ).toBe('steering_denied');
    await runtime.close();
  });

  test('the step request sends each cut tool in place of the turn tool', async () => {
    const runtime = await runtimeOver({
      app: uiDevice('app'),
      web: uiDevice('web'),
    });
    const unified = buildConnectionTools(runtime);
    const offered = offeredTools(
      unified,
      splitStepTools([
        connectionTools('web'),
      ]),
      {
        runtime,
        rootId: 'r',
      },
    );
    const sent = withOffered(unified, offered);
    expect(names(sent)).toEqual(names(unified));
    expect(toolNamed(sent, 'ui_tap')).toBe(toolNamed(offered, 'ui_tap'));
    expect(toolNamed(sent, 'app_call')).toBe(toolNamed(unified, 'app_call'));
    await runtime.close();
  });

  test("<name>_call reads only what the pick and the resource's look allow", async () => {
    const runtime = await runtimeOver({
      app: createInMemoryConnection({
        name: 'app',
        profiles: {
          ui: '1.1.0',
        },
        operations: {
          'ui.scroll': {
            profile: 'ui',
            inputSchema: {
              type: 'object',
            },
            run: () => 'scrolled',
          },
        },
        resources: {
          'ui.tree': {
            look: 'ask',
            read: () => 'tree',
          },
          'ui.summary': {
            look: 'turn',
            read: () => 'summary',
          },
          'screen.current': {
            look: 'ask',
            read: () => 'pixels',
          },
        },
      }),
    });
    const unified = buildConnectionTools(runtime);
    const offered = offeredTools(
      unified,
      splitStepTools([
        connectionTools('app', {
          ops: [
            'ui.*',
          ],
        }),
      ]),
      {
        runtime,
        rootId: 'r',
      },
    );
    const call = toolNamed(offered, 'app_call');
    expect(await runTool(runtime, toolNamed(offered, 'app_ops'), {})).toMatchObject({
      reads: [
        {
          read: 'ui.tree',
        },
      ],
    });
    expect(
      await runTool(runtime, call, {
        read: 'ui.tree',
      }),
    ).toBe('tree');
    expect(
      await deniedRun(runtime, call, {
        read: 'screen.current',
      }),
    ).toBe('steering_denied');
    expect(
      await deniedRun(runtime, call, {
        read: 'ui.summary',
      }),
    ).toBe('steering_denied');
    await runtime.close();
  });

  test('a pick from an entry carries it, so the step attaches it', () => {
    const provider = phone();
    const pick = connectionTools(provider, {
      ops: [
        'ping',
      ],
    });
    expect(pick).toEqual({
      kind: 'connection-pick',
      connection: 'phone',
      ops: [
        'ping',
      ],
      entry: provider,
    });
  });

  test('a pick of a handle with a profile carries its requirement', () => {
    const ui = defineProfile({
      name: 'ui',
      version: '1.1.0',
      operations: {
        'ui.tap': {
          description: 'Tap.',
          input: z.object({}),
          output: z.object({}),
        },
      },
    });
    const pick = connectionTools(connection('app', ui));
    expect(pick.requirement?.profile).toEqual({
      name: 'ui',
      range: '^1.1.0',
    });
    expect(pick.profile?.name).toBe('ui');
  });

  test('a fresh handle or an unnamed entry is CONNECTION_INVALID', () => {
    expect(
      configError(() =>
        connectionTools(
          connection('phones', undefined, {
            fresh: 'run',
          }),
        ),
      ).code,
    ).toBe('CONNECTION_INVALID');
    expect(configError(() => connectionTools(createInMemoryConnection(phoneOptions()))).code).toBe(
      'CONNECTION_INVALID',
    );
  });
});

describe("expose: 'call'", () => {
  test('offers only <name>_ops and <name>_call, and no view layer', async () => {
    const runtime = await runtimeOver({
      phone: {
        provider: phone(),
        expose: 'call',
      },
    });
    const tools = buildConnectionTools(runtime);
    expect(names(tools)).toEqual([
      'phone_call',
      'phone_ops',
    ]);
    expect(connectionViewLayers(runtime)).toEqual([]);
    const ops = tools.find((t) => t.name === 'phone_ops');
    const listed = await ops?.execute({}, frameworkCast({}));
    expect(listed).toMatchObject({
      operations: [
        {
          op: 'ping',
        },
        {
          op: 'reboot',
        },
      ],
    });
    await runtime.close();
  });

  test('two or more merge into one ops and one call that take target', async () => {
    const a = phone('a');
    const b = phone('b');
    const runtime = await runtimeOver({
      a: {
        provider: a,
        expose: 'call',
      },
      b: {
        provider: b,
        expose: 'call',
      },
    });
    const tools = buildConnectionTools(runtime);
    expect(names(tools)).toEqual([
      'call',
      'ops',
    ]);
    const call = tools.find((t) => t.name === 'call');
    expect(call?.inputJsonSchema).toMatchObject({
      properties: {
        target: {
          enum: [
            'a',
            'b',
          ],
        },
      },
    });
    const harness = frameworkCast<Record<string, unknown>>({});
    const { setHarnessInternals } = await import('../../src/util/harness-internals');
    setHarnessInternals(harness, {
      connectionRegistry: runtime,
    });
    const ctx = makeMockContext();
    const output = await call?.execute(
      {
        target: 'b',
        op: 'ping',
        args: {},
      },
      frameworkCast({
        ctx,
        harness,
      }),
    );
    expect(output).toBe('pong');
    expect(b.connection.calls.map((c) => c.op)).toEqual([
      'ping',
    ]);
    expect(a.connection.calls).toEqual([]);
    const refused = await rejection(
      Promise.resolve().then(() =>
        call?.execute(
          {
            op: 'ping',
          },
          frameworkCast({
            ctx,
            harness,
          }),
        ),
      ),
    );
    expect(isNoeticError(refused) && refused.noeticError.kind).toBe('steering_denied');
    await runtime.close();
  });

  test('an unknown expose value is CONNECTION_INVALID', () => {
    expect(
      configError(() =>
        createConnectionRuntime({
          connections: {
            phone: {
              provider: phone(),
              expose: frameworkCast<'call'>('some'),
            },
          },
          storage: makeStorage(),
          artifacts: createInMemoryArtifactStore(),
        }),
      ).code,
    ).toBe('CONNECTION_INVALID');
  });
});
