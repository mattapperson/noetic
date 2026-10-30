// JSON workflows with connections (spec 35 § JSON workflows, § What a document
// may use; spec 33 `$steps` / `$refId` / `$item`): call and wait nodes, op
// shorthand, value wrappers, connection fan-out, manifest checks and the host
// allowlist.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  CallModelRequest,
  ConnectionAllowlist,
  WorkflowDocument,
  WorkflowNode,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { dynamicWorkflow, parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import {
  checkConnectionAllowlist,
  documentConnectionUses,
  globMatches,
} from '../../src/builders/workflow-connections';
import {
  hydrateNode,
  hydrateStepList,
  hydrateWorkflow,
} from '../../src/builders/workflow-hydrator';
import { createInMemoryConnection } from '../../src/connections/in-memory-connection';
import { expressionErrors } from '../../src/expression/check';
import { AgentHarness } from '../../src/harness/agent-harness';
import { setHarnessInternals } from '../../src/util/harness-internals';
import { createDynamicCallModel, makeLLMResponse } from '../_helpers';
import { FakeRegistry, harnessWith } from './_helpers';

//#region Helpers

const SEAL = 's'.repeat(8);

function doc(root: WorkflowNode, connections?: WorkflowDocument['connections']): WorkflowDocument {
  return {
    version: 1,
    ...(connections
      ? {
          connections,
        }
      : {}),
    root,
  };
}

async function runDoc(
  registry: FakeRegistry,
  document: unknown,
  opts: {
    input?: string;
    allowlist?: ConnectionAllowlist;
  } = {},
): Promise<string> {
  const harness = harnessWith(registry);
  return parseAndRunWorkflow({
    json: document,
    harness,
    ctx: harness.createContext(),
    tools: [],
    input: opts.input ?? '',
    maxDepth: 10,
    connections: opts.allowlist,
  });
}

/** The first error in a `step_failed` chain that is not itself a step failure. */
function rootCause(error: unknown): unknown {
  let current = error;
  while (isNoeticError(current) && current.noeticError.kind === 'step_failed') {
    current = current.noeticError.cause;
  }
  return current;
}

async function expectConfig(promise: Promise<unknown>, code: string): Promise<string> {
  try {
    await promise;
    expect.unreachable(`expected ${code}`);
  } catch (e) {
    const cause = rootCause(e);
    assert(isNoeticConfigError(cause));
    expect(cause.code).toBe(code);
    return cause.message;
  }
  return '';
}

function expectConfigSync(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected ${code}`);
  } catch (e) {
    assert(isNoeticConfigError(e));
    expect(e.code).toBe(code);
  }
}

const LOGIN: WorkflowDocument = doc(
  {
    kind: 'sequence',
    id: 'main',
    steps: [
      {
        kind: 'call',
        id: 'email',
        connection: 'app',
        op: 'ui.fill',
        args: {
          element: 'textbox "Email"',
          text: 'qa@example.com',
        },
      },
      {
        kind: 'call',
        id: 'password',
        connection: 'app',
        op: 'ui.fill',
        args: {
          element: 'textbox "Password"',
          text: {
            $secret: 'app.password',
          },
        },
      },
      {
        'ui.tap': {
          element: 'button "Sign in"',
        },
      },
    ],
  },
  {
    app: {
      profile: 'browser@^1.2',
      from: 'browsers',
      fresh: 'path',
      setup: {
        url: 'http://localhost:5173/login',
      },
    },
  },
);

//#endregion

describe('call nodes', () => {
  it("run the spec's login document, shorthand included, on the manifest's connection", async () => {
    const registry = new FakeRegistry({
      browsers: {},
    });
    await runDoc(registry, LOGIN);
    expect(registry.calls.map((c) => c.op)).toEqual([
      'ui.fill',
      'ui.fill',
      'ui.tap',
    ]);
    const [, password, tap] = registry.calls;
    assert(password && tap);
    // Secrets pass through for the registry to resolve at gate 6.
    expect(password.args).toEqual({
      element: 'textbox "Password"',
      text: {
        $secret: 'app.password',
      },
    });
    expect(password.opts.caller).toBe('document');
    expect(
      [
        ...(password.opts.declaredOps ?? []),
      ].sort(),
    ).toEqual([
      'ui.fill',
      'ui.tap',
    ]);
    expect(tap.opts.stepId).toBe('main[2]');
    const request = registry.resolves[0];
    assert(request);
    expect(request.name).toBe('app');
    expect(request.from).toBe('browsers');
    expect(request.fresh).toBe('path');
    expect(request.setup).toEqual({
      url: 'http://localhost:5173/login',
    });
    expect(request.requirement?.profile).toEqual({
      name: 'browser',
      range: '^1.2',
    });
    expect(
      [
        ...(request.requirement?.operations ?? []),
      ].sort(),
    ).toEqual([
      'ui.fill',
      'ui.tap',
    ]);
  });

  it('evaluate $expr against the input, keep $literal untouched, and read earlier outputs through $steps', async () => {
    const registry = new FakeRegistry({
      app: {
        ops: {
          'chat.post': () => ({
            message: {
              $ref: {
                connection: 'app',
                kind: 'chat.message',
                id: 'm-42',
                seal: SEAL,
              },
            },
          }),
          'chat.echo': (args) => args,
        },
      },
    });
    const output = await runDoc(
      registry,
      doc(
        {
          kind: 'sequence',
          id: 'main',
          steps: [
            {
              kind: 'call',
              id: 'post',
              op: 'chat.post',
              args: {
                text: {
                  $expr: "'Hi ' & name",
                },
              },
            },
            {
              kind: 'call',
              id: 'echo',
              op: 'chat.echo',
              args: {
                id: {
                  $expr: '$refId($steps.post.message)',
                },
                raw: {
                  $literal: {
                    $expr: 'not evaluated',
                  },
                },
                missing: {
                  $expr: 'nothing.here',
                },
                list: [
                  1,
                  {
                    $expr: '$exists(message)',
                  },
                  {
                    $expr: 'nothing',
                  },
                ],
              },
            },
          ],
        },
        {
          app: {
            profile: 'chat@^1',
          },
        },
      ),
      {
        input: '{"name":"Ada"}',
      },
    );
    expect(registry.calls[0]?.args).toEqual({
      text: 'Hi Ada',
    });
    expect(JSON.parse(output)).toEqual({
      id: 'm-42',
      raw: {
        $expr: 'not evaluated',
      },
      list: [
        1,
        true,
        null,
      ],
    });
  });

  it('take a whole-args expression, which must give a value', async () => {
    const registry = new FakeRegistry({
      app: {
        ops: {
          'x.y': (args) => args,
        },
      },
    });
    const node: WorkflowNode = {
      kind: 'call',
      id: 'c',
      op: 'x.y',
      args: {
        $expr: '{ "n": n + 1 }',
      },
    };
    const manifest = {
      app: {
        profile: 'x@^1',
      },
    };
    expect(
      JSON.parse(
        await runDoc(registry, doc(node, manifest), {
          input: '{"n":1}',
        }),
      ),
    ).toEqual({
      n: 2,
    });
    await expectConfig(
      runDoc(
        registry,
        doc(
          {
            ...node,
            args: {
              $expr: 'absent',
            },
          },
          manifest,
        ),
      ),
      'EXPRESSION_FAILED',
    );
  });

  it('fail with CONNECTION_UNKNOWN for a connection the manifest does not declare', async () => {
    const message = await expectConfig(
      runDoc(
        new FakeRegistry({}),
        doc(
          {
            kind: 'call',
            id: 'c',
            connection: 'other',
            op: 'ui.tap',
          },
          {
            app: {
              profile: 'ui@^1',
            },
          },
        ),
      ),
      'CONNECTION_UNKNOWN',
    );
    expect(message).toContain("'other'");
  });

  it('fail with CONNECTION_UNKNOWN when a document has no manifest at all', async () => {
    await expectConfig(
      runDoc(
        new FakeRegistry({}),
        doc({
          kind: 'call',
          id: 'c',
          connection: 'app',
          op: 'ui.tap',
        }),
      ),
      'CONNECTION_UNKNOWN',
    );
  });

  it('fail with CONNECTION_INVALID when a node names no connection and several are declared', async () => {
    await expectConfig(
      runDoc(
        new FakeRegistry({}),
        doc(
          {
            kind: 'call',
            id: 'c',
            op: 'ui.tap',
          },
          {
            a: {
              profile: 'ui@^1',
            },
            b: {
              profile: 'ui@^1',
            },
          },
        ),
      ),
      'CONNECTION_INVALID',
    );
  });

  it('fail with CONNECTION_INVALID when a source entry is called or waited on beyond its events', async () => {
    const manifest = {
      deploys: {
        events: [
          'deploy.failed',
        ],
      },
    };
    await expectConfig(
      runDoc(
        new FakeRegistry({}),
        doc(
          {
            kind: 'wait',
            id: 'w',
            event: 'deploy.succeeded',
            timeoutMs: 10,
          },
          manifest,
        ),
      ),
      'CONNECTION_INVALID',
    );
    await expectConfig(
      runDoc(
        new FakeRegistry({}),
        doc(
          {
            kind: 'call',
            id: 'c',
            op: 'deploy.retry',
          },
          manifest,
        ),
      ),
      'CONNECTION_INVALID',
    );
  });

  it('fail validation for an expression that does not parse', async () => {
    const bad = doc(
      {
        kind: 'call',
        id: 'c',
        op: 'ui.fill',
        args: {
          text: {
            $expr: '(((',
          },
        },
      },
      {
        app: {
          profile: 'ui@^1',
        },
      },
    );
    expect(expressionErrors(bad.root)[0]).toContain("args of call node 'c'");
    await expectConfig(runDoc(new FakeRegistry({}), bad), 'WORKFLOW_VALIDATION_FAILED');
  });
});

describe('wait nodes', () => {
  it('listen, run around shorthand on their connection, and match with a filter expression', async () => {
    const registry: FakeRegistry = new FakeRegistry({
      team: {
        ops: {
          'chat.reply': () => {
            registry.emit('team', 'chat.message.created', {
              text: 'no',
              thread: 't-1',
            });
            registry.emit('team', 'chat.message.created', {
              text: 'approve',
              thread: 't-1',
            });
            return {
              posted: true,
            };
          },
        },
      },
    });
    const output = await runDoc(
      registry,
      doc(
        {
          kind: 'wait',
          id: 'approval',
          connection: 'team',
          event: 'chat.message.created',
          filter:
            'event.payload.thread = input.thread and $contains(event.payload.text, "approve")',
          around: [
            {
              'chat.reply': {
                text: 'Approve?',
                thread: {
                  $expr: 'thread',
                },
              },
            },
          ],
          timeoutMs: 1e3,
        },
        {
          team: {
            profile: 'chat@^1',
          },
        },
      ),
      {
        input: '{"thread":"t-1"}',
      },
    );
    const parsed = JSON.parse(output);
    expect(parsed.event.payload.text).toBe('approve');
    expect(parsed.around).toEqual({
      posted: true,
    });
    expect(registry.calls[0]?.args).toEqual({
      text: 'Approve?',
      thread: 't-1',
    });
    expect(registry.calls[0]?.opts.stepId).toBe('approval[0]');
    const request = registry.resolves.find((r) => r.requirement?.events !== undefined);
    expect(request?.requirement?.events).toEqual([
      'chat.message.created',
    ]);
  });
});

describe('connection fan-out', () => {
  it('runs the same steps on each listed connection with $item bound to its name', async () => {
    const registry = new FakeRegistry({
      ios: {
        ops: {
          'ui.tap': () => 'ios tapped',
        },
      },
      android: {
        ops: {
          'ui.tap': () => 'android tapped',
        },
      },
    });
    const output = await runDoc(
      registry,
      doc(
        {
          kind: 'inParallel',
          id: 'both',
          mode: 'all',
          over: [
            'ios',
            'android',
          ],
          each: {
            kind: 'call',
            id: 'tap',
            connection: {
              $expr: '$item',
            },
            op: 'ui.tap',
            args: {
              element: 'button "Pay"',
              on: {
                $expr: '$item',
              },
            },
          },
          merge: 'concat',
        },
        {
          ios: {
            profile: 'device@^1',
          },
          android: {
            profile: 'device@^1',
          },
        },
      ),
      {
        input: 'kept',
      },
    );
    expect(output.split('\n').sort()).toEqual([
      'android tapped',
      'ios tapped',
    ]);
    expect(registry.calls.map((c) => c.args)).toContainEqual({
      element: 'button "Pay"',
      on: 'android',
    });
    expect(registry.resolves.map((r) => r.name).sort()).toEqual([
      'android',
      'ios',
    ]);
  });

  it('checks every fan-out name against the manifest (CONNECTION_UNKNOWN)', async () => {
    await expectConfig(
      runDoc(
        new FakeRegistry({}),
        doc(
          {
            kind: 'inParallel',
            id: 'both',
            mode: 'all',
            over: [
              'ios',
              'web',
            ],
            each: {
              kind: 'call',
              id: 'tap',
              connection: {
                $expr: '$item',
              },
              op: 'ui.tap',
            },
          },
          {
            ios: {
              profile: 'device@^1',
            },
          },
        ),
      ),
      'CONNECTION_UNKNOWN',
    );
  });

  it('fails with CONNECTION_INVALID when a connection expression gives no name', async () => {
    await expectConfig(
      runDoc(
        new FakeRegistry({
          app: {},
        }),
        doc(
          {
            kind: 'call',
            id: 'c',
            connection: {
              $expr: '42',
            },
            op: 'ui.tap',
          },
          {
            app: {
              profile: 'ui@^1',
            },
          },
        ),
      ),
      'CONNECTION_INVALID',
    );
  });
});

describe('allowlist', () => {
  const ALLOW: ConnectionAllowlist = {
    browsers: {
      ops: [
        'ui.*',
        'browser.*',
      ],
      setup: {
        url: [
          'http://localhost:*',
        ],
      },
      secrets: {
        'app.password': 'ui.fill.text',
      },
    },
    slack: {
      ops: [
        'chat.reply',
      ],
      events: [
        'chat.message.created',
      ],
    },
  };

  it('accepts a document within it', () => {
    checkConnectionAllowlist(LOGIN, ALLOW);
  });

  it('refuses a document with connections when there is no allowlist (CONNECTION_NOT_ALLOWED)', () => {
    expectConfigSync(() => checkConnectionAllowlist(LOGIN, undefined), 'CONNECTION_NOT_ALLOWED');
  });

  it('refuses a connection the allowlist does not name', () => {
    expectConfigSync(
      () =>
        checkConnectionAllowlist(LOGIN, {
          slack: ALLOW.slack ?? {},
        }),
      'CONNECTION_NOT_ALLOWED',
    );
  });

  it('refuses an operation outside the allowed globs', () => {
    expectConfigSync(
      () =>
        checkConnectionAllowlist(LOGIN, {
          browsers: {
            ...ALLOW.browsers,
            ops: [
              'browser.*',
            ],
          },
        }),
      'CONNECTION_NOT_ALLOWED',
    );
  });

  it('refuses an event outside the allowed globs', () => {
    const waiting = doc(
      {
        kind: 'wait',
        id: 'w',
        event: 'chat.reaction.added',
        timeoutMs: 10,
      },
      {
        slack: {
          profile: 'chat@^1',
        },
      },
    );
    expectConfigSync(() => checkConnectionAllowlist(waiting, ALLOW), 'CONNECTION_NOT_ALLOWED');
  });

  it('refuses a setup value outside the allowed patterns', () => {
    const remote = structuredClone(LOGIN);
    const entry = remote.connections?.app;
    assert(entry);
    entry.setup = {
      url: 'https://evil.example.com',
    };
    expectConfigSync(() => checkConnectionAllowlist(remote, ALLOW), 'CONNECTION_NOT_ALLOWED');
  });

  it('refuses a setup field the host keeps', () => {
    const remote = structuredClone(LOGIN);
    const entry = remote.connections?.app;
    assert(entry);
    entry.setup = {
      url: 'http://localhost:1',
      command: 'rm -rf /',
    };
    expectConfigSync(() => checkConnectionAllowlist(remote, ALLOW), 'CONNECTION_NOT_ALLOWED');
  });

  it('refuses a secret bound to another field', () => {
    expectConfigSync(
      () =>
        checkConnectionAllowlist(LOGIN, {
          browsers: {
            ...ALLOW.browsers,
            secrets: {
              'app.password': 'ui.fill.element',
            },
          },
        }),
      'CONNECTION_NOT_ALLOWED',
    );
  });

  it('counts a $secret inside $literal as a secret use (CONNECTION_NOT_ALLOWED)', () => {
    const smuggled = doc(
      {
        kind: 'call',
        id: 'fill',
        connection: 'app',
        op: 'ui.fill',
        args: {
          element: 'textbox "Password"',
          text: {
            $literal: {
              $secret: 'prod.admin',
            },
          },
        },
      },
      {
        app: {
          profile: 'ui@^1',
          from: 'browsers',
        },
      },
    );
    expectConfigSync(
      () =>
        checkConnectionAllowlist(smuggled, {
          browsers: {
            ops: [
              'ui.*',
            ],
          },
        }),
      'CONNECTION_NOT_ALLOWED',
    );
  });

  it('a secret an expression produces is refused at the gate, never resolved', async () => {
    const registry = new FakeRegistry({
      browsers: {},
    });
    await runDoc(
      registry,
      doc(
        {
          kind: 'call',
          id: 'fill',
          connection: 'app',
          op: 'ui.fill',
          args: {
            text: {
              $expr: '{ "$secret": "prod.admin" }',
            },
          },
        },
        {
          app: {
            profile: 'ui@^1',
            from: 'browsers',
          },
        },
      ),
      {
        allowlist: {
          browsers: {
            ops: [
              'ui.*',
            ],
          },
        },
      },
    );
    // The registry's gate refuses any secret the node does not write out.
    expect(registry.calls[0]?.opts.caller).toBe('document');
    expect(registry.calls[0]?.opts.documentSecrets).toEqual([]);
  });

  it('is enforced by parseAndRunWorkflow when given', async () => {
    await expectConfig(
      runDoc(
        new FakeRegistry({
          browsers: {},
        }),
        LOGIN,
        {
          allowlist: {
            browsers: {
              ops: [
                'browser.*',
              ],
            },
          },
        },
      ),
      'CONNECTION_NOT_ALLOWED',
    );
  });

  it('must name only harness connections (CONNECTION_UNKNOWN)', async () => {
    await expectConfig(
      runDoc(
        new FakeRegistry({
          browsers: {},
        }),
        LOGIN,
        {
          allowlist: {
            nope: {},
          },
        },
      ),
      'CONNECTION_UNKNOWN',
    );
  });

  it('matches globs exactly', () => {
    expect(globMatches('ui.*', 'ui.tap')).toBe(true);
    expect(globMatches('ui.*', 'browser.ui.tap')).toBe(false);
    expect(globMatches('http://localhost:*', 'http://localhost:5173/login')).toBe(true);
    expect(globMatches('chat.reply', 'chat.replyAll')).toBe(false);
  });

  it('works out the uses a document makes of each connection', () => {
    const uses = documentConnectionUses(LOGIN);
    const app = uses.get('app');
    assert(app);
    expect([
      ...app.ops,
    ]).toEqual([
      'ui.fill',
      'ui.tap',
    ]);
    expect(app.secrets).toEqual([
      {
        name: 'app.password',
        op: 'ui.fill',
        field: 'text',
      },
    ]);
  });
});

describe('dynamicWorkflow with connections', () => {
  function plannerHarness(document: unknown, registry: FakeRegistry): AgentHarness {
    const harness = new AgentHarness({
      name: 'planner',
      params: {},
      _testCallModel: createDynamicCallModel(() => makeLLMResponse(JSON.stringify(document))),
    });
    setHarnessInternals(harness, {
      connectionRegistry: registry,
    });
    return harness;
  }

  it('the planner gets no tools, is shown allowed operations with their schemas, and its bare profile gets a range', async () => {
    const requests: CallModelRequest[] = [];
    const generated = doc(
      {
        kind: 'call',
        id: 'find',
        connection: 'app',
        op: 'ui.find',
        args: {
          query: 'Sign in',
        },
      },
      {
        app: frameworkCast<{
          profile: string;
        }>({
          profile: 'ui',
        }),
      },
    );
    const harness = new AgentHarness({
      name: 'planner',
      params: {},
      connections: {
        app: createInMemoryConnection({
          profiles: {
            ui: '1.3.0',
          },
          operations: {
            'ui.find': {
              profile: 'ui',
              inputSchema: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                  },
                },
              },
              run: () => 'found',
            },
            'ui.tap': {
              profile: 'ui',
              eager: true,
              run: () => 'tapped',
            },
          },
        }),
      },
      _testCallModel: async (request) => {
        requests.push(request);
        return makeLLMResponse(JSON.stringify(generated));
      },
    });
    const output = await harness.run(
      dynamicWorkflow({
        tools: [],
        maxRevisions: 1,
        maxDepth: 10,
        connections: {
          app: {
            ops: [
              'ui.find',
            ],
          },
        },
      }),
      'find the button',
      harness.createContext(),
    );
    expect(output).toBe('found');
    const planner = requests[0];
    assert(planner);
    expect(planner.tools ?? []).toEqual([]);
    const prompt = JSON.stringify(planner);
    expect(prompt).toContain('ui.find args:');
    expect(prompt).toContain('profiles: ui');
    expect(prompt).not.toContain('ui.tap args:');
    await harness.close();
  });

  it('a malformed manifest entry is CONNECTION_INVALID', async () => {
    await expectConfig(
      runDoc(
        new FakeRegistry({
          browsers: {},
        }),
        {
          version: 1,
          connections: {
            app: {
              profile: 'ui',
            },
          },
          root: {
            kind: 'call',
            id: 'c',
            connection: 'app',
            op: 'ui.tap',
          },
        },
      ),
      'CONNECTION_INVALID',
    );
    await expectConfig(
      runDoc(
        new FakeRegistry({
          browsers: {},
        }),
        {
          version: 1,
          connections: {
            app: {
              profile: 'ui@^1',
              surprise: true,
            },
          },
          root: {
            kind: 'call',
            id: 'c',
            connection: 'app',
            op: 'ui.tap',
          },
        },
      ),
      'CONNECTION_INVALID',
    );
  });

  it('refuses a generated document with connections when no allowlist is given', async () => {
    const harness = plannerHarness(LOGIN, new FakeRegistry({}));
    await expectConfig(
      harness.run(
        dynamicWorkflow({
          tools: [],
          maxRevisions: 1,
          maxDepth: 10,
        }),
        'log in',
        harness.createContext(),
      ),
      'CONNECTION_NOT_ALLOWED',
    );
  });

  it('runs a generated document within the allowlist', async () => {
    const registry = new FakeRegistry({
      browsers: {},
    });
    const harness = plannerHarness(LOGIN, registry);
    await harness.run(
      dynamicWorkflow({
        tools: [],
        maxRevisions: 1,
        maxDepth: 10,
        connections: {
          browsers: {
            ops: [
              'ui.*',
            ],
            setup: {
              url: [
                'http://localhost:*',
              ],
            },
            secrets: {
              'app.password': 'ui.fill.text',
            },
          },
        },
      }),
      'log in',
      harness.createContext(),
    );
    expect(registry.calls).toHaveLength(3);
  });
});

describe('hydration helpers', () => {
  it('hydrateStepList turns shorthand into calls on the enclosing connection', () => {
    const steps = hydrateStepList({
      list: [
        {
          'ui.tap': {
            element: 'button "Pay"',
          },
        },
      ],
      parentId: 'checkout',
      ctx: {
        tools: new Map(),
        executeStep: async () => {
          throw new Error('not run');
        },
      },
      enclosing: 'app',
    });
    const [only] = steps;
    assert(only && only.kind === 'call');
    expect(only.id).toBe('checkout[0]');
    expect(only.connection).toBe('app');
  });

  it('a call node without connection or manifest fails with CONNECTION_INVALID', () => {
    expectConfigSync(
      () =>
        hydrateNode(
          {
            kind: 'call',
            id: 'c',
            op: 'ui.tap',
          },
          {
            tools: new Map(),
            executeStep: async () => {
              throw new Error('not run');
            },
          },
        ),
      'CONNECTION_INVALID',
    );
  });
});

describe('verify nodes', () => {
  it('hydrate through the verification hydrator, with act shorthand on the subject', () => {
    const root = hydrateWorkflow(
      doc(
        {
          kind: 'verify',
          id: 'checkout',
          subject: 'app',
          expect: [
            {
              net: 'POST /api/orders 201',
              count: 1,
            },
          ],
          act: [
            {
              'ui.tap': {
                element: 'button "Pay"',
              },
            },
          ],
        },
        {
          app: {
            profile: 'browser@^1',
          },
        },
      ),
      {
        tools: new Map(),
        executeStep: async () => {
          throw new Error('not run');
        },
      },
    );
    expect(root.kind).toBe('verify');
    assert(root.kind === 'verify');
    const act = Array.isArray(root.act)
      ? root.act
      : [
          root.act,
        ];
    const [tap] = act;
    assert(tap && tap.kind === 'call');
    expect(tap.id).toBe('checkout[0]');
    expect(tap.op).toBe('ui.tap');
  });
});
