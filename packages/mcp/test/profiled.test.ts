import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { Connection } from '@noetic-tools/types';
import { isConnectionUnsatisfiedError, isNoeticError } from '@noetic-tools/types';
import type { McpOptions } from '../src/config';
import type { McpConnection } from '../src/connection';
import type { TestServerOptions } from './_helpers';
import { connectOptions, identityResource, structured, TestServer, waitFor } from './_helpers';
import {
  kiosk,
  kioskDeclaration,
  kioskServerOptions,
  kioskState,
  kioskTools,
  stamps,
  ui,
} from './_profiles';

const opened: Connection[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.release()));
});

const signal = new AbortController().signal;

function key(n: number): {
  signal: AbortSignal;
  idempotencyKey: string;
} {
  return {
    signal,
    idempotencyKey: `run:step-${n}`,
  };
}

async function connectKiosk(
  overrides: Partial<TestServerOptions> = {},
  options: McpOptions = {
    profiles: [
      kiosk,
      ui,
    ],
  },
): Promise<{
  connection: McpConnection;
  fixture: TestServer;
  state: ReturnType<typeof kioskState>;
}> {
  const state = kioskState();
  const fixture = new TestServer(kioskServerOptions(state, overrides));
  const [connection] = await fixture.provider(options).connect(connectOptions('kiosk'));
  assert(connection !== undefined);
  opened.push(connection);
  return {
    connection,
    fixture,
    state,
  };
}

async function expectUnavailable(
  overrides: Partial<TestServerOptions>,
  reason: string,
  options: McpOptions = {
    profiles: [
      kiosk,
      ui,
    ],
  },
): Promise<void> {
  const state = kioskState();
  const fixture = new TestServer(kioskServerOptions(state, overrides));
  try {
    await fixture.provider(options).connect(connectOptions('kiosk'));
    throw new Error('expected a throw');
  } catch (error) {
    assert(isNoeticError(error));
    assert(error.noeticError.kind === 'connection_unavailable');
    expect(error.noeticError.connection).toBe('kiosk');
    expect(error.noeticError.reason).toContain(reason);
  }
}

describe('a server declaring profiles', () => {
  it('reads its declaration into the manifest, with profile flags from the catalog', async () => {
    const { connection } = await connectKiosk();
    const manifest = connection.manifest;
    expect(manifest.profiles).toEqual({
      kiosk: '1.0.0',
      ui: '1.1.0',
    });
    expect(Object.keys(manifest.operations).sort()).toEqual([
      'kiosk.print',
      'probe_look',
      'ui.find',
      'ui.tap',
    ]);
    expect(manifest.operations['ui.tap']).toMatchObject({
      eager: true,
      effects: true,
      sense: 'ui',
      profile: 'ui',
    });
    expect(manifest.operations['kiosk.print']).toMatchObject({
      once: true,
      guarded: true,
      profile: 'kiosk',
    });
    expect(manifest.resources['ui.summary']).toMatchObject({
      sense: 'ui',
      look: 'turn',
      profile: 'ui',
    });
    expect(manifest.resources.identity).toBeUndefined();
    expect(manifest.events['kiosk.printed']).toMatchObject({
      replay: 'live',
      sense: 'x-paper',
      thread: 'ticket',
    });
    expect(manifest.events['identity.changed']).toBeUndefined();
    expect(manifest.determinism?.reset).toBe('cheap');
    expect(manifest.senses['x-paper']).toEqual({
      independence: 'independent',
      grade: 'consequence',
    });
  });

  it("takes the catalog from the harness's handles when mcp() was given none", async () => {
    const state = kioskState();
    const fixture = new TestServer(kioskServerOptions(state));
    const [connection] = await fixture.provider({}).connect({
      ...connectOptions('kiosk'),
      profiles: [
        kiosk,
        ui,
      ],
    });
    assert(connection !== undefined);
    opened.push(connection);
    expect(connection.manifest.operations['kiosk.print']).toMatchObject({
      once: true,
      guarded: true,
    });
  });

  it("publishes a profile operation's own input schema, so a sensitive field accepts { $secret }", async () => {
    const { connection } = await connectKiosk();
    const schema = JSON.stringify(connection.manifest.operations['kiosk.print']?.inputSchema);
    expect(schema).toContain('$secret');
  });

  it("a tool an alias maps a guarded operation onto keeps that operation's protections under its own name", async () => {
    const state = kioskState();
    const tools = kioskTools(state).map((tool) =>
      tool.name === 'kiosk.print'
        ? {
            ...tool,
            name: 'printer_raw',
          }
        : tool,
    );
    const { connection } = await connectKiosk({
      tools,
      declaration: kioskDeclaration({
        aliases: {
          'ui.find': {
            tool: 'probe_look',
            fixed: {
              action: 'find',
            },
          },
          'kiosk.print': {
            tool: 'printer_raw',
          },
        },
      }),
    });
    expect(connection.manifest.operations['kiosk.print']).toMatchObject({
      guarded: true,
      once: true,
    });
    expect(connection.manifest.operations.printer_raw).toMatchObject({
      guarded: true,
      once: true,
      effects: true,
    });
  });

  it('refuses a read of a raw URI that is not a declared read', async () => {
    const { connection } = await connectKiosk();
    let refused: unknown;
    try {
      await connection.read('noetic://read/secret-state', {
        signal,
      });
    } catch (error) {
      refused = error;
    }
    assert(isNoeticError(refused));
    expect(refused.noeticError.kind).toBe('connection_failed');
    expect(JSON.stringify(refused.noeticError)).toContain('undeclared');
  });

  it('without a catalog, takes part origins from name prefixes and carries no flags', async () => {
    const { connection } = await connectKiosk({}, {});
    expect(connection.manifest.operations['kiosk.print']).toMatchObject({
      profile: 'kiosk',
    });
    expect(connection.manifest.operations['kiosk.print']?.once).toBeUndefined();
    expect(connection.manifest.events['kiosk.printed']?.replay).toBe('live');
  });

  it('takes its identity from noetic://identity', async () => {
    const { connection } = await connectKiosk();
    expect(connection.identity).toEqual({
      surface: 'x-kiosk',
      instance: 'kiosk-1',
      epoch: 0,
    });
  });

  it('routes an aliased operation to its tool with fixed arguments merged in', async () => {
    const { connection, fixture } = await connectKiosk();
    expect(connection.manifest.operations['ui.find']?.inputSchema).toMatchObject({
      properties: {
        query: {
          type: 'string',
        },
      },
      required: [
        'query',
      ],
    });
    const outcome = await connection.call(
      'ui.find',
      {
        query: 'Print',
        action: 'spoofed',
      },
      key(1),
    );
    expect(outcome).toEqual({
      status: 'ok',
      output: {
        elements: [
          {
            action: 'find',
            query: 'Print',
          },
        ],
      },
    });
    expect(fixture.calls.at(-1)?.name).toBe('probe_look');
  });

  it('passes structured refusals through: ambiguous with candidates, stale_reference, malformed', async () => {
    const { connection } = await connectKiosk();
    const ambiguous = await connection.call(
      'ui.tap',
      {
        element: 'button',
      },
      key(1),
    );
    assert(ambiguous.status === 'error');
    expect(ambiguous.error).toEqual({
      code: 'ambiguous',
      message: 'two buttons match',
      details: {
        candidates: [
          'button "A"',
          'button "B"',
        ],
      },
    });
    const stale = await connection.call(
      'ui.tap',
      {
        element: 'gone',
      },
      key(2),
    );
    assert(stale.status === 'error');
    expect(stale.error.code).toBe('stale_reference');
    const malformed = await connection.call('ui.tap', {}, key(3));
    assert(malformed.status === 'error');
    expect(malformed.error.code).toBe('malformed');
  });

  it('sends tools.noetic/confirmed only when the harness confirmed a guarded call', async () => {
    const { connection, fixture } = await connectKiosk();
    const refused = await connection.call(
      'kiosk.print',
      {
        text: 'hello',
      },
      key(1),
    );
    assert(refused.status === 'error');
    expect(refused.error.code).toBe('guarded');
    expect(fixture.calls.at(-1)?.meta['tools.noetic/confirmed']).toBeUndefined();
    const confirmed = await connection.call(
      'kiosk.print',
      {
        text: 'hello',
      },
      {
        ...key(2),
        confirmed: true,
      },
    );
    expect(confirmed).toEqual({
      status: 'ok',
      output: {
        receipt: {
          actionId: 'a1',
          cursor: null,
        },
      },
    });
    expect(fixture.calls.at(-1)?.meta['tools.noetic/confirmed']).toBe(true);
  });

  it('reads a profile read by name, parsing JSON content', async () => {
    const { connection } = await connectKiosk();
    expect(
      await connection.read('ui.summary', {
        signal,
      }),
    ).toEqual({
      focused: 'button "Print"',
    });
  });

  it('reads coverage and detects anomalies', async () => {
    const { connection } = await connectKiosk();
    assert(connection.coverage !== undefined);
    assert(connection.detect !== undefined);
    expect(
      await connection.coverage('c1', {
        signal,
      }),
    ).toEqual([
      {
        kind: 'channel-unobserved',
        channel: 'x-paper',
        detail: 'printer offline',
        impeaching: true,
      },
    ]);
    const anomalies = await connection.detect(null, {
      signal,
    });
    expect(anomalies[0]?.tier).toBe('observed');
  });

  it('resets through noetic.reset and reports the new identity', async () => {
    const { connection } = await connectKiosk();
    const changes: string[] = [];
    connection.onChange((change) => changes.push(change));
    assert(connection.reset !== undefined);
    await connection.reset({
      signal,
    });
    expect(connection.identity.instance).toBe('kiosk-2');
    expect(changes).toContain('identity');
  });

  it('follows identity.changed events', async () => {
    const { connection, fixture, state } = await connectKiosk();
    await waitFor(() =>
      [
        ...fixture.subscriptions.values(),
      ].some((s) => s.name === 'identity.changed'),
    );
    const changes: string[] = [];
    connection.onChange((change) => changes.push(change));
    state.instance = 'kiosk-replaced';
    await fixture.emit({
      eventId: 'id-1',
      name: 'identity.changed',
      data: {},
    });
    await waitFor(() => changes.includes('identity'));
    expect(connection.identity.instance).toBe('kiosk-replaced');
  });

  it('becomes unavailable when a manifest change contradicts the declaration', async () => {
    const { connection, fixture } = await connectKiosk();
    const changes: string[] = [];
    connection.onChange((change) => changes.push(change));
    fixture.tools = fixture.tools.filter((tool) => tool.name !== 'ui.tap');
    await fixture.notifyAll('notifications/tools/list_changed');
    await waitFor(() => changes.includes('manifest'));
    expect(connection.unavailable).toContain("required operation 'ui.tap'");
    const outcome = await connection.call(
      'ui.find',
      {
        query: 'x',
      },
      key(1),
    );
    assert(outcome.status === 'error');
    expect(outcome.error.code).toBe('unavailable');
  });
});

describe('a server contradicting its declaration is unavailable', () => {
  it('when the declaration is malformed', async () => {
    await expectUnavailable(
      {
        declaration: {
          profiles: {
            KIOSK: 'one',
          },
        },
      },
      'malformed',
    );
  });

  it('when an alias names a tool it does not serve', async () => {
    await expectUnavailable(
      {
        declaration: kioskDeclaration({
          aliases: {
            'ui.find': {
              tool: 'missing_tool',
            },
          },
        }),
      },
      "'missing_tool'",
    );
  });

  it('when it declares a sense more trustworthy than OVP allows', async () => {
    await expectUnavailable(
      {
        declaration: kioskDeclaration({
          senses: {
            ui: {
              independence: 'independent',
              grade: 'consequence',
            },
          },
        }),
      },
      'OVP-CHAN-1',
    );
  });

  it('when it serves no noetic://identity', async () => {
    const state = kioskState();
    await expectUnavailable(
      {
        resources: kioskServerOptions(state).resources?.filter(
          (r) => r.uri !== 'noetic://identity',
        ),
      },
      'noetic://identity',
    );
  });

  it('when it declares a resettable determinism but serves no noetic.reset', async () => {
    const state = kioskState();
    await expectUnavailable(
      {
        tools: kioskServerOptions(state).tools?.filter((t) => t.name !== 'noetic.reset'),
      },
      'noetic.reset',
    );
  });

  it('when its determinism is more forgiving than its profile allows', async () => {
    await expectUnavailable(
      {
        declaration: kioskDeclaration({
          determinism: {
            reset: 'cheap',
            replayPrefix: 'free',
            time: 'stepped',
            observation: 'exact',
            actions: 'reversible',
          },
        }),
      },
      'time',
    );
  });

  it("when it serves an event with a weaker replay than its profile's", async () => {
    await expectUnavailable(
      {
        events: [
          {
            name: 'kiosk.printed',
            replay: 'none',
          },
          {
            name: 'identity.changed',
          },
        ],
      },
      "replay 'none'",
    );
  });

  it('when a required operation is missing', async () => {
    const state = kioskState();
    await expectUnavailable(
      {
        tools: kioskServerOptions(state).tools?.filter((t) => t.name !== 'kiosk.print'),
      },
      "required operation 'kiosk.print'",
    );
  });

  it('when a tool does not accept a required field', async () => {
    const state = kioskState();
    const tools = (kioskServerOptions(state).tools ?? []).map((tool) =>
      tool.name === 'kiosk.print'
        ? {
            ...tool,
            inputSchema: {
              type: 'object',
              properties: {},
            },
          }
        : tool,
    );
    await expectUnavailable(
      {
        tools,
      },
      "required field 'text'",
    );
  });

  it('when a parent profile is missing', async () => {
    await expectUnavailable(
      {
        declaration: kioskDeclaration({
          profiles: {
            kiosk: '1.0.0',
          },
        }),
      },
      'parent ui@^1',
    );
  });

  it('when a required read or event is missing', async () => {
    const state = kioskState();
    await expectUnavailable(
      {
        resources: kioskServerOptions(state).resources?.filter((r) => r.name !== 'ui.summary'),
      },
      "required read 'ui.summary'",
    );
    await expectUnavailable(
      {
        events: [
          {
            name: 'identity.changed',
          },
        ],
      },
      "required event 'kiosk.printed'",
    );
  });

  it('when it leaves out, or over-trusts, an x- sense its profile uses', async () => {
    await expectUnavailable(
      {
        declaration: kioskDeclaration({
          senses: {
            ui: {
              independence: 'actuation-derived',
              grade: 'presence',
            },
          },
        }),
      },
      "no 'x-paper' sense",
    );
  });

  it('when it serves no identity.changed event', async () => {
    await expectUnavailable(
      {
        events: [
          {
            name: 'kiosk.printed',
            replay: 'live',
          },
        ],
      },
      'identity.changed',
    );
  });

  it('when a declared extension lacks a required operation', async () => {
    await expectUnavailable(
      {
        declaration: kioskDeclaration({
          extensions: {
            'com.example.stamps': '1.0.0',
          },
        }),
      },
      "required operation 'com.example.stamps.stamp'",
      {
        profiles: [
          kiosk,
          ui,
        ],
        extensions: [
          stamps,
        ],
      },
    );
  });
});

describe('one server serving several instances', () => {
  it('returns one connection per instance, each carrying tools.noetic/instance', async () => {
    const state = kioskState();
    const fixture = new TestServer(
      kioskServerOptions(state, {
        declaration: kioskDeclaration({
          instances: [
            {
              id: 'left',
            },
            {
              id: 'right',
            },
          ],
        }),
        resources: [
          identityResource(() => ({
            surface: 'x-kiosk',
            instance: 'shared',
          })),
          ...(kioskServerOptions(state).resources ?? []).filter(
            (r) => r.uri !== 'noetic://identity',
          ),
        ],
      }),
    );
    const connections = await fixture.provider().connect(connectOptions('kiosks'));
    opened.push(...connections);
    expect(connections.map((c) => c.id)).toEqual([
      'kiosks/left',
      'kiosks/right',
    ]);
    await connections[1]?.call(
      'ui.tap',
      {
        element: 'x',
      },
      key(1),
    );
    expect(fixture.calls.at(-1)?.meta['tools.noetic/instance']).toBe('right');
  });
});

describe('provision', () => {
  it('provisions through noetic.provision and releases through noetic.release', async () => {
    const state = kioskState();
    const options = kioskServerOptions(state);
    const fixture = new TestServer({
      ...options,
      tools: [
        ...(options.tools ?? []),
        {
          name: 'noetic.provision',
          handler: (args) =>
            structured({
              instance: `fresh-${JSON.stringify(args.setup)}`,
            }),
        },
        {
          name: 'noetic.release',
          handler: () => structured({}),
        },
      ],
    });
    const connection = await fixture.provider().provision(
      {
        url: 'x',
      },
      connectOptions('pool'),
    );
    expect(connection.id).toBe('pool/fresh-{"url":"x"}');
    expect(Object.keys(connection.manifest.operations)).not.toContain('noetic.provision');
    await connection.release();
    expect(fixture.calls.at(-1)).toMatchObject({
      name: 'noetic.release',
      args: {
        instance: 'fresh-{"url":"x"}',
      },
    });
  });

  it('gives a fresh session per connection when the server cannot provision and setup is empty', async () => {
    const state = kioskState();
    const fixture = new TestServer(kioskServerOptions(state));
    const provider = fixture.provider();
    const a = await provider.provision({}, connectOptions('pool'));
    const b = await provider.provision({}, connectOptions('pool'));
    opened.push(a, b);
    expect(fixture.servers.length).toBe(2);
  });

  it('refuses with CONNECTION_UNSATISFIED when setup is given but the server cannot provision', async () => {
    const state = kioskState();
    const fixture = new TestServer(kioskServerOptions(state));
    try {
      await fixture.provider().provision(
        {
          url: 'x',
        },
        connectOptions('pool'),
      );
      throw new Error('expected a throw');
    } catch (error) {
      assert(isConnectionUnsatisfiedError(error));
      expect(error.code).toBe('CONNECTION_UNSATISFIED');
      expect(error.missing).toEqual({
        kind: 'operation',
        op: 'noetic.provision',
      });
    }
  });
});
