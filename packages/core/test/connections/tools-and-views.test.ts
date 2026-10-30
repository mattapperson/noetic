import { describe, expect, test } from 'bun:test';
import type { ConnectionsConfig, Tool, ToolExecutionContext } from '@noetic-tools/types';
import {
  defineProfile,
  frameworkCast,
  isNoeticConfigError,
  isNoeticError,
  receipt,
} from '@noetic-tools/types';
import { z } from 'zod';
import { connection } from '../../src/connections/handle';
import type { InMemoryConnectionOptions } from '../../src/connections/in-memory-connection';
import { createInMemoryConnection } from '../../src/connections/in-memory-connection';
import {
  buildConnectionTools,
  connectionToolName,
  connectionTools,
  runtimeOf,
} from '../../src/connections/model-tools';
import type { ConnectionRuntime } from '../../src/connections/registry';
import { createConnectionRuntime } from '../../src/connections/registry';
import type { ConnectionViewState } from '../../src/connections/views';
import { connectionViewLayer, connectionViewLayers, lineDiff } from '../../src/connections/views';
import { createInMemoryArtifactStore } from '../../src/runtime/in-memory-artifact-store';
import { setHarnessInternals } from '../../src/util/harness-internals';
import {
  makeCtx,
  makeItemLog,
  makeMockContext,
  makeMockToolContext,
  makeStorage,
} from '../_helpers';

//#region Fixtures

const OBJECT_SCHEMA = {
  type: 'object',
} as const;

function deviceOptions(summary: () => unknown = () => 'home screen'): InMemoryConnectionOptions {
  return {
    profiles: {
      ui: '1.1.0',
    },
    operations: {
      'ui.tap': {
        profile: 'ui',
        eager: true,
        effects: true,
        description: 'Tap an element.',
        inputSchema: {
          type: 'object',
          properties: {
            element: {
              type: 'string',
            },
          },
        },
        run: (args, context) => ({
          tapped: args,
          by: context.connection.id,
        }),
      },
      'ui.scroll': {
        profile: 'ui',
        inputSchema: OBJECT_SCHEMA,
        run: () => ({
          scrolled: true,
        }),
      },
    },
    resources: {
      'ui.summary': {
        look: 'turn',
        read: summary,
      },
      'ui.tree': {
        look: 'effect',
        read: () => ({
          nodes: 3,
        }),
      },
      'screen.current': {
        look: 'ask',
        read: () => ({
          $blob: {
            uri: `artifact://sha256/${'a'.repeat(64)}`,
            mimeType: 'image/png',
            bytes: 10,
            sha256: 'a'.repeat(64),
          },
        }),
      },
    },
  };
}

async function runtimeWith(connections: ConnectionsConfig): Promise<ConnectionRuntime> {
  const runtime = createConnectionRuntime({
    connections,
    storage: makeStorage(),
    artifacts: createInMemoryArtifactStore(),
  });
  await runtime.start();
  return runtime;
}

function toolCtxFor(runtime: ConnectionRuntime | undefined): ToolExecutionContext {
  const base = makeMockToolContext(makeMockContext());
  const harness = frameworkCast<ToolExecutionContext['harness']>({
    ...base.harness,
  });
  setHarnessInternals(harness, {
    connectionRegistry: runtime,
  });
  return {
    ...base,
    harness,
  };
}

function named(tools: ReadonlyArray<Tool>, name: string): Tool {
  const found = tools.find((t) => t.name === name);
  if (!found) {
    throw new Error(`no tool ${name} in ${tools.map((t) => t.name).join(', ')}`);
  }
  return found;
}

async function run(tool: Tool, args: unknown, toolCtx: ToolExecutionContext): Promise<unknown> {
  const result = tool.execute(frameworkCast<never>(args), toolCtx);
  if (result instanceof Promise) {
    return result;
  }
  throw new Error('expected a promise');
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

//#endregion

describe('buildConnectionTools', () => {
  test("eager exposes the profile's eager operations plus <name>_ops and <name>_call", async () => {
    const runtime = await runtimeWith({
      phone: createInMemoryConnection(deviceOptions()),
    });
    const tools = buildConnectionTools(runtime);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'phone_call',
      'phone_ops',
      'phone_ui_tap',
    ]);
    const ctx = toolCtxFor(runtime);
    expect(
      await run(
        named(tools, 'phone_ui_tap'),
        {
          element: 'OK',
        },
        ctx,
      ),
    ).toEqual({
      tapped: {
        element: 'OK',
      },
      by: 'memory',
    });
    const listed = z
      .object({
        operations: z.array(
          z.object({
            op: z.string(),
          }),
        ),
        reads: z.array(
          z.object({
            read: z.string(),
          }),
        ),
      })
      .parse(await run(named(tools, 'phone_ops'), {}, ctx));
    expect(listed.operations.map((o) => o.op)).toEqual([
      'ui.scroll',
    ]);
    expect(listed.reads.map((r) => r.read)).toEqual([
      'screen.current',
    ]);
    expect(
      await run(
        named(tools, 'phone_call'),
        {
          op: 'ui.scroll',
          args: {},
        },
        ctx,
      ),
    ).toEqual({
      scrolled: true,
    });
    expect(
      await run(
        named(tools, 'phone_call'),
        {
          read: 'screen.current',
        },
        ctx,
      ),
    ).toMatchObject({
      $blob: {
        mimeType: 'image/png',
      },
    });
    const refused = await rejected(
      run(
        named(tools, 'phone_call'),
        {
          op: 'ui.tap',
        },
        ctx,
      ),
    );
    expect(isNoeticError(refused) && refused.noeticError.kind).toBe('steering_denied');
  });

  test("'all' exposes every operation; 'none' exposes nothing; no profile passes tools through", async () => {
    const runtime = await runtimeWith({
      all: {
        provider: createInMemoryConnection(deviceOptions()),
        expose: 'all',
      },
      none: {
        provider: createInMemoryConnection(deviceOptions()),
        expose: 'none',
      },
      plain: createInMemoryConnection({
        operations: {
          browser_navigate: {
            inputSchema: OBJECT_SCHEMA,
            run: () => 'ok',
          },
        },
      }),
    });
    const names = buildConnectionTools(runtime)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      'all_call',
      'all_ops',
      'all_ui_scroll',
      'all_ui_tap',
      'plain_browser_navigate',
    ]);
  });

  test('the same profile operation on two connections is one tool with a target', async () => {
    const runtime = await runtimeWith({
      ios: createInMemoryConnection(deviceOptions()),
      android: createInMemoryConnection({
        ...deviceOptions(),
        id: 'android-1',
      }),
    });
    const tools = buildConnectionTools(runtime);
    const tap = named(tools, 'ui_tap');
    expect(tap.inputJsonSchema).toMatchObject({
      properties: {
        target: {
          enum: [
            'ios',
            'android',
          ],
        },
      },
    });
    const ctx = toolCtxFor(runtime);
    expect(
      await run(
        tap,
        {
          element: 'OK',
          target: 'android',
        },
        ctx,
      ),
    ).toEqual({
      tapped: {
        element: 'OK',
      },
      by: 'android-1',
    });
    const noTarget = await rejected(
      run(
        tap,
        {
          element: 'OK',
        },
        ctx,
      ),
    );
    expect(isNoeticError(noTarget) && noTarget.noeticError.kind).toBe('steering_denied');
  });

  test('two operations under one tool name are CONNECTION_TOOL_COLLISION', async () => {
    const runtime = await runtimeWith({
      a: createInMemoryConnection({
        operations: {
          b_c: {
            run: () => 1,
          },
        },
      }),
      a_b: createInMemoryConnection({
        operations: {
          c: {
            run: () => 1,
          },
        },
      }),
    });
    let caught: unknown;
    try {
      buildConnectionTools(runtime);
    } catch (e) {
      caught = e;
    }
    expect(isNoeticConfigError(caught) && caught.code).toBe('CONNECTION_TOOL_COLLISION');
  });

  test('tool names replace characters a tool name cannot carry', () => {
    expect(connectionToolName('app', 'ui.tap')).toBe('app_ui_tap');
    expect(runtimeOf(undefined)).toBeUndefined();
    expect(runtimeOf({})).toBeUndefined();
  });
});

describe('connectionTools(handle)', () => {
  const ui = defineProfile({
    name: 'ui',
    version: '1.1.0',
    operations: {
      'ui.tap': {
        description: 'Tap.',
        input: z.object({
          element: z.string(),
        }),
        output: z.object({
          receipt: receipt(),
        }),
        effects: true,
        eager: true,
      },
      'ui.scroll': {
        description: 'Scroll.',
        input: z.object({}),
        output: z.object({}),
      },
    },
  });

  test('offers the profile operations matching ops, typed from the profile', async () => {
    const runtime = await runtimeWith({
      phone: createInMemoryConnection(deviceOptions()),
    });
    const tools = connectionTools(connection('phone', ui), {
      ops: [
        'ui.tap',
      ],
    });
    expect(tools.map((t) => t.name)).toEqual([
      'phone_ui_tap',
    ]);
    expect(tools[0]?.inputJsonSchema).toMatchObject({
      properties: {
        element: {
          type: 'string',
        },
      },
    });
    expect(
      await run(
        named(tools, 'phone_ui_tap'),
        {
          element: 'OK',
        },
        toolCtxFor(runtime),
      ),
    ).toMatchObject({
      tapped: {
        element: 'OK',
      },
    });
  });

  test('without a profile offers one <name>_call limited to ops', async () => {
    const runtime = await runtimeWith({
      phone: createInMemoryConnection(deviceOptions()),
    });
    const [call] = connectionTools(connection('phone'), {
      ops: [
        'ui.scroll',
      ],
    });
    if (!call) {
      throw new Error('no tool');
    }
    const ctx = toolCtxFor(runtime);
    expect(
      await run(
        call,
        {
          op: 'ui.scroll',
        },
        ctx,
      ),
    ).toEqual({
      scrolled: true,
    });
    const refused = await rejected(
      run(
        call,
        {
          op: 'ui.tap',
        },
        ctx,
      ),
    );
    expect(isNoeticError(refused) && refused.noeticError.kind).toBe('steering_denied');
    const noRuntime = await rejected(
      run(
        call,
        {
          op: 'ui.scroll',
        },
        toolCtxFor(undefined),
      ),
    );
    expect(isNoeticError(noRuntime) && noRuntime.noeticError.kind).toBe('steering_denied');
  });
});

describe('connection views', () => {
  async function recall(
    runtime: ConnectionRuntime,
    state: ConnectionViewState | undefined,
  ): Promise<{
    readonly text: string | undefined;
    readonly state: ConnectionViewState | undefined;
  }> {
    const layer = connectionViewLayer(runtime, 'phone');
    const result = await layer.hooks.recall?.({
      log: makeItemLog(),
      query: '',
      ctx: makeCtx(),
      state: state ?? {
        previous: {},
        effects: -1,
      },
      budget: 1e3,
    });
    if (result === null || result === undefined || typeof result === 'string') {
      return {
        text: result ?? undefined,
        state,
      };
    }
    const item = result.items[0];
    const text =
      item && 'content' in item && Array.isArray(item.content)
        ? z
            .array(
              z.object({
                text: z.string(),
              }),
            )
            .parse(item.content)
            .map((c) => c.text)
            .join('')
        : undefined;
    return {
      text,
      state: result.state,
    };
  }

  test('turn reads every turn as diffs, effect reads after effects, ask reads never', async () => {
    let screen = 'home screen';
    const runtime = await runtimeWith({
      phone: createInMemoryConnection(deviceOptions(() => screen)),
    });
    const first = await recall(runtime, undefined);
    expect(first.text).toContain('<read name="ui.summary">\nhome screen');
    // An 'effect' read waits for an operation that changed the connection.
    expect(first.text).not.toContain('ui.tree');
    expect(first.text).not.toContain('screen.current');
    const second = await recall(runtime, first.state);
    expect(second.text).toContain('(unchanged)');
    expect(second.text).not.toContain('ui.tree');
    screen = 'settings';
    const resolved = await runtime.resolve({
      name: 'phone',
      scope: {
        executionId: 'e',
        threadId: 't',
        scopeKey: 'e',
        signal: new AbortController().signal,
      },
    });
    await resolved.call(
      'ui.tap',
      {
        element: 'Settings',
      },
      {
        signal: new AbortController().signal,
        caller: 'step',
        idempotencyKey: 'k',
      },
    );
    const third = await recall(runtime, second.state);
    expect(third.text).toContain('settings');
    expect(third.text).toContain('<read name="ui.tree">');
    const fourth = await recall(runtime, third.state);
    expect(fourth.text).not.toContain('ui.tree');
  });

  test('look on the harness entry overrides the profile default', async () => {
    const runtime = await runtimeWith({
      phone: {
        provider: createInMemoryConnection(deviceOptions()),
        look: {
          'ui.summary': 'ask',
          'ui.tree': 'ask',
          'screen.current': 'turn',
        },
      },
    });
    const view = await recall(runtime, undefined);
    expect(view.text).toContain(`[image/png 10 bytes: artifact://sha256/${'a'.repeat(64)}]`);
    expect(view.text).not.toContain('ui.summary');
  });

  test('renders nothing without a ready connection or reads; one layer per non-pool connection', async () => {
    const runtime = createConnectionRuntime({
      connections: {
        phone: createInMemoryConnection({}),
        pool: {
          provider: createInMemoryConnection({
            provision: () => undefined,
          }),
          pool: {
            max: 1,
          },
        },
      },
      storage: makeStorage(),
      artifacts: createInMemoryArtifactStore(),
    });
    expect((await recall(runtime, undefined)).text).toBeUndefined();
    await runtime.start();
    expect((await recall(runtime, undefined)).text).toBeUndefined();
    expect(connectionViewLayers(runtime).map((l) => l.id)).toEqual([
      'noetic/connection-view/phone',
    ]);
  });

  test('lineDiff marks removed and added lines', () => {
    expect(lineDiff('a\nb', 'a\nc')).toBe('- b\n+ c');
  });
});
