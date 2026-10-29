import { describe, expect, test } from 'bun:test';
import type {
  ConnectionEvent,
  ConnectionsConfig,
  EventStreamMessage,
  NoeticError,
  SteeringDecision,
} from '@noetic-tools/types';
import {
  defineProfile,
  isConnectionUnsatisfiedError,
  isNoeticConfigError,
  isNoeticError,
  isRef,
  REDACTED_TEXT,
  secret,
} from '@noetic-tools/types';
import { z } from 'zod';
import type { GateHooks } from '../../src/connections/gates';
import type { InMemoryConnectionOptions } from '../../src/connections/in-memory-connection';
import {
  createInMemoryConnection,
  inMemoryRefusal,
} from '../../src/connections/in-memory-connection';
import type {
  ConnectionFrameworkEventRecord,
  ConnectionRuntime,
} from '../../src/connections/registry';
import { createConnectionRuntime } from '../../src/connections/registry';
import type { ConnectionScope, GatedCallOptions } from '../../src/connections/registry-types';
import { createInMemoryArtifactStore } from '../../src/runtime/in-memory-artifact-store';
import { makeStorage, sleep } from '../_helpers';

//#region Fixtures

const OBJECT_SCHEMA = {
  type: 'object',
} as const;

const FILL_SCHEMA = {
  type: 'object',
  properties: {
    text: {
      anyOf: [
        {
          type: 'string',
        },
        {
          type: 'object',
          properties: {
            $secret: {
              type: 'string',
            },
          },
        },
      ],
    },
  },
  required: [
    'text',
  ],
};

function appOptions(overrides: Partial<InMemoryConnectionOptions> = {}): InMemoryConnectionOptions {
  return {
    profiles: {
      browser: '1.2.0',
      ui: '1.1.0',
    },
    operations: {
      'browser.open': {
        profile: 'browser',
        eager: true,
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
            },
          },
          required: [
            'url',
          ],
        },
        run: (args) => ({
          tab: {
            $ref: {
              kind: 'browser.tab',
              id: `tab-for-${JSON.stringify(args)}`,
            },
          },
        }),
      },
      'ui.tap': {
        profile: 'ui',
        eager: true,
        effects: true,
        inputSchema: OBJECT_SCHEMA,
        run: () => ({
          receipt: {
            actionId: 'a1',
            cursor: null,
          },
        }),
      },
      'ui.fill': {
        profile: 'ui',
        effects: true,
        inputSchema: FILL_SCHEMA,
        run: (args) => ({
          echoed: args,
        }),
      },
      'ui.close': {
        profile: 'ui',
        inputSchema: OBJECT_SCHEMA,
        run: (args) => args,
      },
      'browser.evaluate': {
        profile: 'browser',
        guarded: true,
        inputSchema: OBJECT_SCHEMA,
        run: () => ({
          value: 42,
        }),
      },
      'ui.broken': {
        profile: 'ui',
        inputSchema: OBJECT_SCHEMA,
        run: () => {
          throw inMemoryRefusal('ambiguous', 'two buttons match', {
            candidates: [
              'a',
              'b',
            ],
          });
        },
      },
      'device.install': {
        task: [
          {
            state: 'working',
            progress: {
              current: 1,
              total: 2,
            },
          },
          {
            state: 'input_required',
            request: {
              id: 'q1',
              message: 'Trust this developer?',
            },
          },
        ],
        inputSchema: OBJECT_SCHEMA,
        run: (_args, context) => ({
          trusted: context.answers.get('q1'),
        }),
      },
      'device.build': {
        task: [
          {
            state: 'working',
            message: 'compiling',
          },
        ],
        inputSchema: OBJECT_SCHEMA,
        run: () => ({
          built: true,
        }),
      },
    },
    events: {
      'chat.message.created': {
        thread: 'thread',
      },
    },
    resources: {
      'browser.page.summary': {
        look: 'turn',
        read: () => ({
          url: 'https://example.com',
        }),
      },
    },
    determinism: {
      reset: 'cheap',
      replayPrefix: 'unsafe',
      time: 'wall',
      observation: 'exact',
      actions: 'reversible',
    },
    reset: () => undefined,
    ...overrides,
  };
}

interface Rig {
  readonly runtime: ConnectionRuntime;
  readonly events: ConnectionFrameworkEventRecord[];
  readonly app: ReturnType<typeof createInMemoryConnection>;
}

function rig(
  options: {
    readonly connections?: ConnectionsConfig;
    readonly hooks?: GateHooks;
    readonly app?: InMemoryConnectionOptions;
    readonly secretValue?: string;
  } = {},
): Rig {
  const app = createInMemoryConnection(options.app ?? appOptions());
  const events: ConnectionFrameworkEventRecord[] = [];
  const runtime = createConnectionRuntime({
    connections: options.connections ?? {
      app,
    },
    storage: makeStorage(),
    artifacts: createInMemoryArtifactStore(),
    hooks: options.hooks,
    secrets: {
      async resolve() {
        return options.secretValue ?? 's3cret-value';
      },
    },
    onFrameworkEvent: (event) => events.push(event),
    reconnectDelayMs: () => 5,
  });
  return {
    runtime,
    events,
    app,
  };
}

function scope(overrides: Partial<ConnectionScope> = {}): ConnectionScope {
  return {
    executionId: 'exec-1',
    threadId: 'thread-1',
    scopeKey: 'exec-1',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function callOptions(overrides: Partial<GatedCallOptions> = {}): GatedCallOptions {
  return {
    signal: new AbortController().signal,
    caller: 'step',
    idempotencyKey: `key-${crypto.randomUUID()}`,
    ...overrides,
  };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

function noeticErrorOf(e: unknown): NoeticError {
  if (!isNoeticError(e)) {
    throw new Error(`expected a NoeticError, got ${String(e)}`);
  }
  return e.noeticError;
}

const allow: SteeringDecision = {
  action: 'allow',
};

//#endregion

describe('construction', () => {
  test('a malformed entry is CONNECTION_INVALID', () => {
    const bad: ReadonlyArray<ConnectionsConfig> = [
      {
        '1bad': createInMemoryConnection(),
      },
      {
        app: {
          provider: JSON.parse('{}'),
        },
      },
      {
        app: {
          provider: createInMemoryConnection(),
          expose: JSON.parse('"sometimes"'),
        },
      },
      {
        app: {
          provider: createInMemoryConnection(),
          pool: {
            max: 1,
          },
        },
      },
      {
        app: {
          provider: createInMemoryConnection({
            provision: () => undefined,
          }),
          pool: {
            max: 0,
          },
        },
      },
    ];
    for (const connections of bad) {
      let caught: unknown;
      try {
        rig({
          connections,
        });
      } catch (e) {
        caught = e;
      }
      expect(isNoeticConfigError(caught) && caught.code).toBe('CONNECTION_INVALID');
    }
  });

  test('names() lists every entry, pools included', () => {
    const { runtime } = rig({
      connections: {
        app: createInMemoryConnection(),
        browsers: {
          provider: createInMemoryConnection({
            provision: () => undefined,
          }),
          pool: {
            max: 2,
          },
        },
      },
    });
    expect(runtime.names()).toEqual([
      'app',
      'browsers',
    ]);
  });
});

describe('resolve', () => {
  test('an unknown name is CONNECTION_UNKNOWN', async () => {
    const { runtime } = rig();
    const e = await rejected(
      runtime.resolve({
        name: 'nope',
        scope: scope(),
      }),
    );
    expect(isNoeticConfigError(e) && e.code).toBe('CONNECTION_UNKNOWN');
  });

  test('connects lazily, reports status and emits connection_changed', async () => {
    const { runtime, events } = rig();
    expect(runtime.status('app')[0]?.state).toBe('connecting');
    await runtime.start();
    const [status] = runtime.status();
    expect(status?.state).toBe('ready');
    expect(status?.identity?.surface).toBe('x-memory');
    expect(events.some((e) => e.type === 'connection_changed')).toBe(true);
    expect(runtime.status('nope')).toEqual([]);
  });

  test('an unsatisfied requirement is CONNECTION_UNSATISFIED', async () => {
    const { runtime } = rig();
    const e = await rejected(
      runtime.resolve({
        name: 'app',
        scope: scope(),
        requirement: {
          profile: {
            name: 'browser',
            range: '^2',
          },
        },
      }),
    );
    expect(isConnectionUnsatisfiedError(e)).toBe(true);
  });

  test('parents of the handle profile are checked too', async () => {
    const screen = defineProfile({
      name: 'screen',
      version: '1.0.0',
    });
    const browser = defineProfile({
      name: 'browser',
      version: '1.2.0',
      extends: {
        screen: screen.range('^1'),
      },
    });
    const { runtime } = rig();
    const e = await rejected(
      runtime.resolve({
        name: 'app',
        scope: scope(),
        profile: browser,
        requirement: {
          profile: {
            name: 'browser',
            range: '^1',
          },
        },
      }),
    );
    expect(isConnectionUnsatisfiedError(e) && e.missing).toEqual({
      kind: 'profile',
      profile: 'screen',
      range: '^1',
    });
  });

  test('fresh on a connection that is not a pool is CONNECTION_INVALID', async () => {
    const { runtime } = rig();
    const e = await rejected(
      runtime.resolve({
        name: 'app',
        scope: scope(),
        fresh: 'run',
      }),
    );
    expect(isNoeticConfigError(e) && e.code).toBe('CONNECTION_INVALID');
  });

  test('a provider that cannot connect is connection_unavailable and others keep working', async () => {
    const { runtime } = rig({
      connections: {
        good: createInMemoryConnection(appOptions()),
        bad: createInMemoryConnection({
          failConnect: 'boom',
        }),
      },
    });
    await runtime.start();
    expect(runtime.status('bad')[0]).toMatchObject({
      state: 'unavailable',
      reason: 'boom',
    });
    const e = await rejected(
      runtime.resolve({
        name: 'bad',
        scope: scope(),
      }),
    );
    expect(noeticErrorOf(e)).toMatchObject({
      kind: 'connection_unavailable',
      connection: 'bad',
    });
    const good = await runtime.resolve({
      name: 'good',
      scope: scope(),
    });
    expect(await good.call('ui.close', {}, callOptions())).toEqual({});
    await runtime.close();
  });
});

describe('gated calls', () => {
  test('returns the output with provider refs sealed to the thread', async () => {
    const { runtime } = rig();
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    const output = z
      .object({
        tab: z.unknown(),
      })
      .parse(
        await app.call(
          'browser.open',
          {
            url: 'https://example.com',
          },
          callOptions(),
        ),
      );
    expect(isRef(output.tab)).toBe(true);
    expect(await app.call('ui.close', output, callOptions())).toEqual(output);
    const other = await runtime.resolve({
      name: 'app',
      scope: scope({
        threadId: 'thread-2',
      }),
    });
    const e = await rejected(other.call('ui.close', output, callOptions()));
    expect(noeticErrorOf(e).kind).toBe('connection_ref_invalid');
  });

  test('gate 1: an operation the connection lacks, or the handle does not declare, is steering_denied', async () => {
    const { runtime, app: provider } = rig();
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    const missing = await rejected(app.call('ui.pinch', {}, callOptions()));
    expect(noeticErrorOf(missing).kind).toBe('steering_denied');
    const undeclared = await rejected(
      app.call(
        'ui.close',
        {},
        callOptions({
          declaredOps: [
            'ui.tap',
          ],
        }),
      ),
    );
    expect(noeticErrorOf(undeclared).kind).toBe('steering_denied');
    expect(provider.connection.calls).toHaveLength(0);
  });

  test('gate 2: arguments that do not match the schema are steering_denied, never defaulted', async () => {
    const { runtime, app: provider } = rig();
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    const e = await rejected(app.call('browser.open', {}, callOptions()));
    const error = noeticErrorOf(e);
    expect(error.kind === 'steering_denied' && error.guidance).toContain('.url: required');
    expect(provider.connection.calls).toHaveLength(0);
  });

  test('gate 4: policy deny is steering_denied; approve asks the approver', async () => {
    const approvals: string[] = [];
    const { runtime, app: provider } = rig({
      connections: {
        app: {
          provider: createInMemoryConnection(appOptions()),
          policy: {
            deny: [
              'ui.close',
            ],
            approve: [
              'ui.tap',
            ],
          },
        },
      },
      hooks: {
        async approve(request) {
          approvals.push(request.op);
          return allow;
        },
      },
    });
    void provider;
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    expect(noeticErrorOf(await rejected(app.call('ui.close', {}, callOptions()))).kind).toBe(
      'steering_denied',
    );
    await app.call('ui.tap', {}, callOptions());
    expect(approvals).toEqual([
      'ui.tap',
    ]);
  });

  test('guarded operations need approval: refused without an approver, sent confirmed with one', async () => {
    const without = rig();
    const app = await without.runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    const e = await rejected(app.call('browser.evaluate', {}, callOptions()));
    expect(noeticErrorOf(e).kind).toBe('steering_denied');

    const withApprover = rig({
      hooks: {
        approve: async () => allow,
      },
    });
    const approved = await withApprover.runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    expect(await approved.call('browser.evaluate', {}, callOptions())).toEqual({
      value: 42,
    });
    expect(withApprover.app.connection.calls[0]?.options.confirmed).toBe(true);
  });

  test("a server's guarded refusal is approved and retried with confirmed", async () => {
    const reasons: Array<string | undefined> = [];
    const { runtime, app: provider } = rig({
      app: appOptions({
        operations: {
          'chat.delete': {
            inputSchema: OBJECT_SCHEMA,
            guarded: false,
            run: (_args, context) => {
              if (!context.confirmed) {
                throw inMemoryRefusal('guarded', 'really delete?');
              }
              return {
                deleted: true,
              };
            },
          },
        },
      }),
      hooks: {
        async approve(request) {
          reasons.push(request.reason);
          return allow;
        },
      },
    });
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    expect(await app.call('chat.delete', {}, callOptions())).toEqual({
      deleted: true,
    });
    expect(reasons).toEqual([
      'guarded',
    ]);
    expect(provider.connection.calls.map((c) => c.options.confirmed)).toEqual([
      undefined,
      true,
    ]);
  });

  test("a server's guarded refusal of an op the policy allows is confirmed without asking", async () => {
    const app = createInMemoryConnection(
      appOptions({
        operations: {
          'chat.delete': {
            inputSchema: OBJECT_SCHEMA,
            run: (_args, context) => {
              if (!context.confirmed) {
                throw inMemoryRefusal('guarded', 'really delete?');
              }
              return {
                deleted: true,
              };
            },
          },
        },
      }),
    );
    const { runtime } = rig({
      connections: {
        app: {
          provider: app,
          policy: {
            allow: [
              'chat.delete',
            ],
          },
        },
      },
    });
    const resolved = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    expect(await resolved.call('chat.delete', {}, callOptions())).toEqual({
      deleted: true,
    });
    expect(app.connection.calls.map((c) => c.options.confirmed)).toEqual([
      undefined,
      true,
    ]);
  });

  test('gate 5: a beforeCall refusal is steering_denied for steps but skipped for model calls', async () => {
    const seen: string[] = [];
    const { runtime } = rig({
      hooks: {
        async beforeCall(request) {
          seen.push(request.caller);
          return {
            action: 'deny',
            guidance: 'no taps today',
          };
        },
      },
    });
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    const e = await rejected(app.call('ui.tap', {}, callOptions()));
    expect(noeticErrorOf(e)).toEqual({
      kind: 'steering_denied',
      guidance: 'no taps today',
    });
    await app.call(
      'ui.tap',
      {},
      callOptions({
        caller: 'model',
      }),
    );
    expect(seen).toEqual([
      'step',
    ]);
  });

  test('a server refusal is connection_failed carrying the wire error', async () => {
    const { runtime } = rig();
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    const e = await rejected(app.call('ui.broken', {}, callOptions()));
    expect(noeticErrorOf(e)).toEqual({
      kind: 'connection_failed',
      connection: 'app',
      op: 'ui.broken',
      error: {
        code: 'ambiguous',
        message: 'two buttons match',
        details: {
          candidates: [
            'a',
            'b',
          ],
        },
      },
    });
  });

  test('gate 6: secrets are filled only when sent and scrubbed from outputs', async () => {
    const { runtime, app: provider } = rig();
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    const output = await app.call(
      'ui.fill',
      {
        text: secret('app.password'),
      },
      callOptions(),
    );
    expect(provider.connection.calls[0]?.args).toEqual({
      text: 's3cret-value',
    });
    expect(output).toEqual({
      echoed: {
        text: REDACTED_TEXT,
      },
    });
  });

  test('secrets from the model are connection_secret_refused', async () => {
    const { runtime } = rig();
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    const e = await rejected(
      app.call(
        'ui.fill',
        {
          text: secret('app.password'),
        },
        callOptions({
          caller: 'model',
        }),
      ),
    );
    expect(noeticErrorOf(e).kind).toBe('connection_secret_refused');
  });

  test('a document may send only the secrets its node writes out (not one an expression produced)', async () => {
    const { runtime, app: provider } = rig();
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    const produced = await rejected(
      app.call(
        'ui.fill',
        {
          text: secret('prod.admin'),
        },
        callOptions({
          caller: 'document',
          documentSecrets: [],
        }),
      ),
    );
    expect(noeticErrorOf(produced).kind).toBe('connection_secret_refused');
    const otherField = await rejected(
      app.call(
        'ui.fill',
        {
          text: secret('prod.admin'),
        },
        callOptions({
          caller: 'document',
          documentSecrets: [
            {
              name: 'app.password',
              field: 'text',
            },
          ],
        }),
      ),
    );
    expect(noeticErrorOf(otherField).kind).toBe('connection_secret_refused');
    expect(provider.connection.calls).toHaveLength(0);
    await app.call(
      'ui.fill',
      {
        text: secret('app.password'),
      },
      callOptions({
        caller: 'document',
        documentSecrets: [
          {
            name: 'app.password',
            field: 'text',
          },
        ],
      }),
    );
    expect(provider.connection.calls).toHaveLength(1);
  });

  test('effects operations bump the effect count', async () => {
    const { runtime } = rig();
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    expect(runtime.effectCount('app')).toBe(0);
    await app.call('ui.close', {}, callOptions());
    expect(runtime.effectCount('app')).toBe(0);
    await app.call('ui.tap', {}, callOptions());
    expect(runtime.effectCount('app')).toBe(1);
    expect(runtime.effectCount('nope')).toBe(0);
  });

  test('once operations return the original outcome for a repeated key', async () => {
    let runs = 0;
    const { runtime } = rig({
      app: appOptions({
        operations: {
          'chat.post': {
            inputSchema: OBJECT_SCHEMA,
            effects: true,
            once: true,
            run: () => {
              runs += 1;
              return {
                n: runs,
              };
            },
          },
        },
      }),
    });
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    const opts = callOptions({
      idempotencyKey: 'same',
    });
    expect(await app.call('chat.post', {}, opts)).toEqual({
      n: 1,
    });
    expect(await app.call('chat.post', {}, opts)).toEqual({
      n: 1,
    });
    const conflict = await rejected(
      app.call(
        'chat.post',
        {
          other: 1,
        },
        opts,
      ),
    );
    const error = noeticErrorOf(conflict);
    expect(error.kind === 'connection_failed' && error.error.code).toBe('conflict');
  });
});

describe('long operations', () => {
  test('are waited on, reporting progress as connection_task', async () => {
    const { runtime, events } = rig();
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    const progress: string[] = [];
    expect(
      await app.call(
        'device.build',
        {},
        callOptions({
          onTask: (status) => progress.push(status.state),
        }),
      ),
    ).toEqual({
      built: true,
    });
    expect(progress).toEqual([
      'working',
      'completed',
    ]);
    expect(events.filter((e) => e.type === 'connection_task')).toHaveLength(2);
  });

  test('a question nobody answers is connection_input_required', async () => {
    const { runtime } = rig();
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    const e = await rejected(app.call('device.install', {}, callOptions()));
    expect(noeticErrorOf(e)).toEqual({
      kind: 'connection_input_required',
      connection: 'app',
      request: {
        id: 'q1',
        message: 'Trust this developer?',
      },
    });
  });

  test('a question the hooks answer lets the task finish', async () => {
    const { runtime } = rig({
      hooks: {
        answerInput: async () => ({
          answer: 'yes',
        }),
      },
    });
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    expect(await app.call('device.install', {}, callOptions())).toEqual({
      trusted: 'yes',
    });
  });
});

describe('reads and events', () => {
  test('read goes through the registry', async () => {
    const { runtime } = rig();
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    expect(
      await app.read('browser.page.summary', {
        signal: new AbortController().signal,
      }),
    ).toEqual({
      url: 'https://example.com',
    });
  });

  test('listen stamps the connection, seals refs and reports gaps and the end', async () => {
    const { runtime, app: provider, events } = rig();
    const app = await runtime.resolve({
      name: 'app',
      scope: scope(),
    });
    const stream = app.listen({
      event: 'chat.message.created',
      signal: new AbortController().signal,
    });
    await stream.ready;
    await sleep(0);
    provider.connection.emit('chat.message.created', {
      thread: {
        $ref: {
          kind: 'chat.thread',
          id: 'T1',
        },
      },
    });
    provider.connection.gap('server restarted');
    provider.connection.terminate('bye');
    const received: EventStreamMessage<ConnectionEvent>[] = [];
    for await (const message of stream) {
      received.push(message);
    }
    expect(received.map((m) => m.type)).toEqual([
      'event',
      'gap',
      'terminated',
    ]);
    const first = received[0];
    if (first?.type !== 'event') {
      throw new Error('expected an event');
    }
    expect(first.event.connection).toBe('app');
    const payload = z
      .object({
        thread: z.unknown(),
      })
      .parse(first.event.payload);
    expect(isRef(payload.thread)).toBe(true);
    expect(
      events
        .filter((e) => e.type === 'stream_changed')
        .map((e) => ('change' in e.data ? e.data.change : undefined)),
    ).toEqual([
      'gap',
      'ended',
    ]);
    expect(events.some((e) => e.type === 'connection_event')).toBe(true);
  });
});

describe('reconnection and renegotiation', () => {
  test('a dropped connection is unavailable, then reconnects to a new connection', async () => {
    const { runtime, app: provider } = rig();
    await runtime.start();
    const first = provider.connection;
    first.drop('server crashed');
    await sleep(0);
    expect(runtime.status('app')[0]).toMatchObject({
      state: 'unavailable',
      reason: 'server crashed',
    });
    await sleep(30);
    expect(runtime.status('app')[0]?.state).toBe('ready');
    expect(provider.connects).toBe(2);
    expect(provider.connection).not.toBe(first);
    await runtime.close();
    expect(runtime.status('app')[0]?.state).toBe('closed');
  });

  test('a manifest change that drops a required operation makes the connection unavailable', async () => {
    const { runtime, app: provider } = rig();
    runtime.require('app', {
      operations: [
        'ui.tap',
      ],
    });
    await runtime.start();
    provider.connection.updateManifest({
      operations: {},
    });
    expect(runtime.status('app')[0]?.state).toBe('unavailable');
    expect(() => runtime.require('nope', {})).toThrow();
  });

  test('a connection that reports itself unavailable (a contradicted declaration) is connection_unavailable until it clears', async () => {
    const { runtime, app: provider } = rig();
    await runtime.start();
    let down: string | undefined = 'the server contradicts its declared profile';
    Object.defineProperty(provider.connection, 'unavailable', {
      get: () => down,
    });
    provider.connection.updateManifest({});
    expect(runtime.status('app')[0]).toMatchObject({
      state: 'unavailable',
      reason: 'the server contradicts its declared profile',
    });
    const e = await rejected(
      runtime.resolve({
        name: 'app',
        scope: scope(),
      }),
    );
    expect(noeticErrorOf(e).kind).toBe('connection_unavailable');
    down = undefined;
    provider.connection.updateManifest({});
    expect(runtime.status('app')[0]?.state).toBe('ready');
    await runtime.close();
  });
});

describe('resume', () => {
  test('same instance keeps; a replaced unsafe connection refuses until rerun', async () => {
    const { runtime, app: provider } = rig();
    await runtime.start();
    const recorded = provider.connection.identity;
    const signal = new AbortController().signal;
    expect(
      await runtime.checkResume({
        executionId: 'run-1',
        name: 'app',
        recorded,
        signal,
      }),
    ).toBe('keep');
    provider.connection.replace();
    const e = await rejected(
      runtime.checkResume({
        executionId: 'run-1',
        name: 'app',
        recorded,
        signal,
      }),
    );
    expect(noeticErrorOf(e).kind).toBe('connection_resume_refused');
    runtime.allowRerun('run-1', [
      'app',
    ]);
    expect(
      await runtime.checkResume({
        executionId: 'run-1',
        name: 'app',
        recorded,
        signal,
      }),
    ).toBe('discard');
  });

  test('a costly connection with reset is reset', async () => {
    let resets = 0;
    const { runtime, app: provider } = rig({
      app: appOptions({
        determinism: {
          reset: 'cheap',
          replayPrefix: 'costly',
          time: 'wall',
          observation: 'exact',
          actions: 'reversible',
        },
        reset: () => {
          resets += 1;
        },
      }),
    });
    await runtime.start();
    const recorded = provider.connection.identity;
    provider.connection.replace();
    expect(
      await runtime.checkResume({
        executionId: 'run-1',
        name: 'app',
        recorded,
        signal: new AbortController().signal,
      }),
    ).toBe('reset');
    expect(resets).toBe(1);
    const e = await rejected(
      runtime.checkResume({
        executionId: 'run-1',
        name: 'nope',
        recorded,
        signal: new AbortController().signal,
      }),
    );
    expect(isNoeticConfigError(e) && e.code).toBe('CONNECTION_UNKNOWN');
  });
});

describe('pools', () => {
  function poolRig(max = 1, waitMs = 20): Rig {
    const browser = defineProfile({
      name: 'browser',
      version: '1.0.0',
      setup: {
        schema: z.object({
          url: z.string().optional(),
          command: z.string().optional(),
        }),
        hostOnly: [
          'command',
        ],
      },
    });
    void browser;
    return rig({
      connections: {
        browsers: {
          provider: createInMemoryConnection(
            appOptions({
              provision: () => undefined,
            }),
          ),
          pool: {
            max,
            waitMs,
          },
        },
      },
    });
  }

  const browserProfile = defineProfile({
    name: 'browser',
    version: '1.2.0',
    setup: {
      schema: z
        .object({
          url: z.string().optional(),
          command: z.string().optional(),
        })
        .strict(),
      hostOnly: [
        'command',
      ],
    },
  });

  test('a scope gets one fresh connection, held under a lease, released with the scope', async () => {
    const { runtime, events } = poolRig(2);
    await runtime.start();
    const first = await runtime.resolve({
      name: 'app',
      from: 'browsers',
      fresh: 'path',
      setup: {
        url: 'http://localhost:5173',
      },
      scope: scope({
        scopeKey: 'path-a',
      }),
    });
    const again = await runtime.resolve({
      name: 'browsers',
      fresh: 'path',
      scope: scope({
        scopeKey: 'path-a',
      }),
    });
    expect(first.lease?.id).toBe(again.lease?.id ?? 'missing');
    expect(first.lease).toMatchObject({
      pool: 'browsers',
      scope: 'path',
      holder: 'path-a',
    });
    expect(await first.call('ui.close', {}, callOptions())).toEqual({});
    expect(runtime.status('browsers')[0]?.pool).toEqual({
      max: 2,
      leased: 1,
      idle: 0,
    });
    await runtime.releaseScope('path-a');
    expect(runtime.status('browsers')[0]?.pool?.leased).toBe(0);
    const e = await rejected(first.call('ui.close', {}, callOptions()));
    expect(noeticErrorOf(e).kind).toBe('connection_unavailable');
    const changes = events
      .map((ev) => ('lease' in ev.data ? ev.data.lease?.change : undefined))
      .filter((c) => c !== undefined);
    expect(changes).toEqual([
      'acquired',
      'released',
    ]);
  });

  test('a ref one lease issued is refused on another lease of the same pool, even on one thread', async () => {
    const { runtime } = poolRig(2);
    await runtime.start();
    const pathA = await runtime.resolve({
      name: 'browsers',
      fresh: 'path',
      scope: scope({
        scopeKey: 'run:path:a',
      }),
    });
    const pathB = await runtime.resolve({
      name: 'browsers',
      fresh: 'path',
      scope: scope({
        scopeKey: 'run:path:b',
      }),
    });
    const opened = await pathA.call(
      'browser.open',
      {
        url: 'http://localhost',
      },
      callOptions(),
    );
    const tab = z
      .object({
        tab: z.unknown(),
      })
      .parse(opened).tab;
    expect(isRef(tab)).toBe(true);
    expect(
      await pathA.call(
        'ui.close',
        {
          tab,
        },
        callOptions(),
      ),
    ).toEqual({
      tab,
    });
    const e = await rejected(
      pathB.call(
        'ui.close',
        {
          tab,
        },
        callOptions(),
      ),
    );
    expect(noeticErrorOf(e).kind).toBe('connection_ref_invalid');
  });

  test("orphanRun stops renewing a failed run's leases so they are reclaimed; a resume takes them back", async () => {
    const { runtime } = poolRig(2);
    await runtime.start();
    for (const scopeKey of [
      'failed',
      'kept',
    ]) {
      await runtime.resolve({
        name: 'browsers',
        fresh: 'run',
        scope: scope({
          scopeKey,
        }),
      });
    }
    runtime.orphanRun('failed');
    runtime.orphanRun('kept');
    // Resolving again within the reclaim window takes the lease back.
    await runtime.resolve({
      name: 'browsers',
      fresh: 'run',
      scope: scope({
        scopeKey: 'kept',
      }),
    });
    expect(runtime.status('browsers')[0]?.pool?.leased).toBe(2);
    await runtime.close();
  });

  test("releaseRun returns the run's own lease and its paths' leases, and no other run's", async () => {
    const { runtime } = poolRig(4);
    await runtime.start();
    for (const scopeKey of [
      'root-1',
      'root-1:path:a',
      'root-1:path:b',
      'root-10',
    ]) {
      await runtime.resolve({
        name: 'browsers',
        fresh: scopeKey.includes(':path:') ? 'path' : 'run',
        scope: scope({
          scopeKey,
        }),
      });
    }
    expect(runtime.status('browsers')[0]?.pool?.leased).toBe(4);
    await runtime.releaseRun('root-1');
    expect(runtime.status('browsers')[0]?.pool?.leased).toBe(1);
    await runtime.releaseRun('root-1');
    expect(runtime.status('browsers')[0]?.pool?.leased).toBe(1);
    await runtime.releaseRun('root-10');
    expect(runtime.status('browsers')[0]?.pool?.leased).toBe(0);
  });

  test('a full pool queues, then fails with connection_unavailable past waitMs', async () => {
    const { runtime } = poolRig(1, 20);
    await runtime.resolve({
      name: 'browsers',
      fresh: 'run',
      scope: scope({
        scopeKey: 'run-a',
      }),
    });
    const e = await rejected(
      runtime.resolve({
        name: 'browsers',
        fresh: 'run',
        scope: scope({
          scopeKey: 'run-b',
        }),
      }),
    );
    expect(noeticErrorOf(e)).toMatchObject({
      kind: 'connection_unavailable',
      connection: 'browsers',
    });
  });

  test('a queued request gets the connection another scope releases', async () => {
    const { runtime } = poolRig(1, 1e3);
    await runtime.resolve({
      name: 'browsers',
      fresh: 'run',
      scope: scope({
        scopeKey: 'run-a',
      }),
    });
    const waiting = runtime.resolve({
      name: 'browsers',
      fresh: 'run',
      scope: scope({
        scopeKey: 'run-b',
      }),
    });
    await sleep(5);
    await runtime.releaseScope('run-a');
    const second = await waiting;
    expect(second.lease?.holder).toBe('run-b');
  });

  test('a host-only setup field is CONNECTION_NOT_ALLOWED; a malformed setup is CONNECTION_INVALID', async () => {
    const { runtime } = poolRig(2);
    const notAllowed = await rejected(
      runtime.resolve({
        name: 'browsers',
        fresh: 'run',
        profile: browserProfile,
        setup: {
          command: 'rm -rf /',
        },
        scope: scope(),
      }),
    );
    expect(isNoeticConfigError(notAllowed) && notAllowed.code).toBe('CONNECTION_NOT_ALLOWED');
    const invalid = await rejected(
      runtime.resolve({
        name: 'browsers',
        fresh: 'run',
        profile: browserProfile,
        setup: {
          viewport: 3,
        },
        scope: scope(),
      }),
    );
    expect(isNoeticConfigError(invalid) && invalid.code).toBe('CONNECTION_INVALID');
  });

  test('a pooled connection that does not satisfy the requirement is released', async () => {
    const { runtime } = poolRig(1);
    const e = await rejected(
      runtime.resolve({
        name: 'browsers',
        fresh: 'run',
        requirement: {
          operations: [
            'ui.pinch',
          ],
        },
        scope: scope({
          scopeKey: 'r1',
        }),
      }),
    );
    expect(isConnectionUnsatisfiedError(e)).toBe(true);
    expect(runtime.status('browsers')[0]?.pool?.leased).toBe(0);
  });
});
