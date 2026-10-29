/**
 * QA script 2 (spec 35 § JSON workflows, spec 37 § In JSON): JSON documents
 * with a connections manifest, `call`, `wait` and `verify` nodes, operations
 * written by name, `$secret` and `$steps`, run through `parseAndRunWorkflow`
 * and `dynamicWorkflow` against the stdio `ui@1` server — plus invalid
 * documents that must fail with the spec's error codes.
 *
 * Run: `bun examples/connections/json-workflow.ts`. Exits non-zero when a check fails.
 */

import { join } from 'node:path';
import type { SecretResolver } from '@noetic-tools/core';
import { AgentHarness, dynamicWorkflow, parseAndRunWorkflow } from '@noetic-tools/core';
import { mcp } from '@noetic-tools/mcp';
import { verifier } from '@noetic-tools/verify';
import { ui } from '../../packages/profile-ui/src/index';
import { functionCall, message, startFakeModel } from './_fake-model';
import type { ServerCall, Settled } from './_qa';
import {
  check,
  finish,
  readServerLog,
  SERVER_PATH,
  scratchDir,
  section,
  settle,
  show,
} from './_qa';

//#region Fixtures

/** `ConnectionAllowlist` is not exported from `@noetic-tools/core`; derive it. */
type ConnectionAllowlist = NonNullable<Parameters<typeof parseAndRunWorkflow>[0]['connections']>;

const PASSWORD = 'pa55-JSON-SECRET-77';

const secrets: SecretResolver = {
  resolve: async (name) => {
    if (name === 'app.password') {
      return PASSWORD;
    }
    throw new Error(`no secret ${name}`);
  },
};

const dir = scratchDir('json');

function server(name: string, sensitiveSchema = true): ReturnType<typeof mcp> {
  return mcp({
    command: 'bun',
    args: [
      SERVER_PATH,
    ],
    env: {
      UI_SERVER_LOG: join(dir, `${name}.jsonl`),
      UI_SERVER_INSTANCE: name,
      UI_SERVER_SENSITIVE_SCHEMA: sensitiveSchema ? '1' : '0',
    },
    profiles: [
      ui,
    ],
  });
}

function serverLog(name: string): ServerCall[] {
  return readServerLog(join(dir, `${name}.jsonl`));
}

function harnessWith(
  connections: Record<string, ReturnType<typeof mcp>>,
  withVerifier = true,
): AgentHarness {
  return new AgentHarness({
    name: 'qa-json',
    params: {},
    connections,
    environment: {
      secrets,
    },
    ...(withVerifier
      ? {
          verification: verifier(),
        }
      : {}),
  });
}

/** The planner prompt's part about connections, up to the node list. */
function connectionsSection(prompt: string): string {
  const start = prompt.indexOf('Connections you may use');
  if (start < 0) {
    return '';
  }
  return prompt.slice(start, prompt.indexOf('Connection nodes', start));
}

/** The error a planner retry prompt quotes. */
function retryError(prompt: string): string {
  const start = prompt.indexOf('Previous attempt failed with error:');
  return start < 0 ? '' : prompt.slice(start, start + 400);
}

async function runDoc(
  harness: AgentHarness,
  json: unknown,
  connections?: ConnectionAllowlist,
): Promise<Settled> {
  return settle(
    parseAndRunWorkflow({
      json,
      harness,
      ctx: harness.createContext(),
      tools: [],
      ...(connections === undefined
        ? {}
        : {
            connections,
          }),
    }),
  );
}

function expectCode(name: string, s: Settled, codes: ReadonlyArray<string>): void {
  const got = s.ok ? 'ok' : (s.code ?? s.kind ?? 'other');
  check(`${name} → ${codes.join(' | ')}`, !s.ok && codes.includes(got), `got ${got}: ${show(s)}`);
}

//#endregion

//#region Documents

const LOGIN_DOC = {
  version: 1,
  connections: {
    app: {
      profile: 'ui@^1',
    },
  },
  root: {
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
        kind: 'call',
        id: 'find',
        connection: 'app',
        op: 'ui.find',
        args: {
          query: 'button "help"',
        },
      },
      {
        kind: 'call',
        id: 'tap-help-by-ref',
        connection: 'app',
        op: 'ui.tap',
        args: {
          element: {
            $expr: '$steps.find.elements[0].element',
          },
        },
      },
      {
        kind: 'verify',
        id: 'sign-in',
        subject: 'app',
        intent: 'Signing in shows the welcome heading',
        expect: [
          {
            ui: 'heading "Welcome"',
          },
        ],
        act: [
          {
            'ui.tap': {
              element: 'button "Sign in"',
            },
          },
        ],
        close: {
          quietMs: 100,
          timeoutMs: 3e3,
        },
      },
    ],
  },
};

//#endregion

await section(
  'a valid document: manifest, call, $secret, $steps, ref, op shorthand, verify',
  async () => {
    const harness = harnessWith({
      app: server('doc-1'),
    });
    try {
      const out = await runDoc(harness, LOGIN_DOC);
      check('parseAndRunWorkflow runs the document', out.ok, show(out));
      const calls = serverLog('doc-1');
      console.log(`      server saw: ${calls.map((c) => c.tool).join(', ')}`);
      check(
        '$secret reached the server resolved',
        calls.some((c) => c.tool === 'ui.fill' && c.args.text === PASSWORD),
        calls,
      );
      check(
        'a ref read with $steps routed back to the server as its id',
        calls.some((c) => c.tool === 'ui.tap' && JSON.stringify(c.args).includes('"e4"')),
        calls.filter((c) => c.tool === 'ui.tap'),
      );
      check(
        'the op shorthand in act ran as a call on the verify subject',
        calls.some((c) => c.tool === 'ui.tap' && c.args.element === 'button "Sign in"'),
        calls.filter((c) => c.tool === 'ui.tap'),
      );
      const text = out.ok ? String(out.value) : '';
      check(
        'a ui-only claim on an actuation-derived ui sense is unknown (OVP: the subject agreeing with itself is not evidence)',
        text.includes('"outcome":"unknown"') && text.includes('no-independent-consequence'),
        text.slice(0, 600),
      );
      check(
        'the verify output carries the run record as a blob ref',
        text.includes('"run":{"$blob"'),
        text.slice(0, 300),
      );
      check('the output never contains the secret', !text.includes(PASSWORD));
    } finally {
      await harness.closeConnections();
    }
  },
);

await section(
  'a document with a $secret against a server whose own schema says string',
  async () => {
    const harness = harnessWith({
      app: server('doc-plain', false),
    });
    try {
      const out = await runDoc(harness, {
        version: 1,
        connections: {
          app: {
            profile: 'ui@^1',
          },
        },
        root: {
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
      });
      check(
        "$secret in ui.fill.text (sensitive in ui@1) is accepted whatever the server's own tool schema says",
        out.ok,
        show(out),
      );
    } finally {
      await harness.closeConnections();
    }
  },
);

await section('wait node with an around written by name and a filter expression', async () => {
  const harness = harnessWith({
    app: server('doc-wait'),
  });
  try {
    const out = await runDoc(harness, {
      version: 1,
      connections: {
        app: {
          profile: 'ui@^1',
        },
      },
      root: {
        kind: 'wait',
        id: 'welcome',
        connection: 'app',
        event: 'ui.changed',
        filter: "$contains(event.payload.summary, 'Welcome')",
        around: [
          {
            'ui.tap': {
              element: 'button "Sign in"',
            },
          },
        ],
        timeoutMs: 5e3,
      },
    });
    check('the wait node catches the event its around causes', out.ok, show(out));
    const text = out.ok ? String(out.value) : '';
    check(
      'its output is { event, around }',
      text.includes('"event"') && text.includes('"around"'),
      text,
    );
  } finally {
    await harness.closeConnections();
  }
});

await section('fan-out: inParallel over connection names', async () => {
  const harness = harnessWith({
    left: server('fan-left'),
    right: server('fan-right'),
  });
  try {
    const out = await runDoc(harness, {
      version: 1,
      connections: {
        left: {
          profile: 'ui@^1',
        },
        right: {
          profile: 'ui@^1',
        },
      },
      root: {
        kind: 'inParallel',
        id: 'both',
        mode: 'all',
        over: [
          'left',
          'right',
        ],
        each: {
          kind: 'call',
          id: 'tap',
          connection: {
            $expr: '$item',
          },
          op: 'ui.tap',
          args: {
            element: 'button "Help"',
          },
        },
      },
    });
    check('inParallel over two connection names runs', out.ok, show(out));
    check(
      'each connection got its own call',
      serverLog('fan-left').some((c) => c.tool === 'ui.tap') &&
        serverLog('fan-right').some((c) => c.tool === 'ui.tap'),
      {
        left: serverLog('fan-left'),
        right: serverLog('fan-right'),
      },
    );
    const bad = await runDoc(harness, {
      version: 1,
      connections: {
        left: {
          profile: 'ui@^1',
        },
      },
      root: {
        kind: 'inParallel',
        id: 'both',
        mode: 'all',
        over: [
          'left',
          'nowhere',
        ],
        each: {
          kind: 'call',
          id: 'tap',
          connection: {
            $expr: '$item',
          },
          op: 'ui.tap',
          args: {
            element: 'button "Help"',
          },
        },
      },
    });
    expectCode('fan-out over a name the manifest lacks fails validation', bad, [
      'CONNECTION_UNKNOWN',
      'CONNECTION_INVALID',
      'WORKFLOW_VALIDATION_FAILED',
    ]);
  } finally {
    await harness.closeConnections();
  }
});

await section('invalid documents', async () => {
  const harness = harnessWith({
    app: server('invalid'),
  });
  const noVerifier = harnessWith(
    {
      app: server('invalid-nv'),
    },
    false,
  );
  try {
    const call = (op: string, args: Record<string, unknown> = {}): Record<string, unknown> => ({
      kind: 'call',
      id: `c-${op}`,
      connection: 'app',
      op,
      args,
    });
    const doc = (
      root: unknown,
      connections: unknown = {
        app: {
          profile: 'ui@^1',
        },
      },
    ): unknown => ({
      version: 1,
      connections,
      root,
    });

    expectCode(
      'manifest names a connection the harness does not have',
      await runDoc(
        harness,
        doc(
          call('ui.find', {
            query: 'x',
          }),
          {
            ghost: {
              profile: 'ui@^1',
            },
          },
        ),
      ),
      [
        'CONNECTION_UNKNOWN',
      ],
    );
    expectCode(
      'a node names a connection missing from the manifest',
      await runDoc(
        harness,
        doc({
          ...call('ui.find', {
            query: 'x',
          }),
          connection: 'ghost',
        }),
      ),
      [
        'CONNECTION_UNKNOWN',
        'CONNECTION_INVALID',
      ],
    );
    expectCode(
      'manifest asks for ui@^2 but the server speaks ui 1.0.0',
      await runDoc(
        harness,
        doc(
          call('ui.find', {
            query: 'x',
          }),
          {
            app: {
              profile: 'ui@^2',
            },
          },
        ),
      ),
      [
        'CONNECTION_UNSATISFIED',
      ],
    );
    expectCode(
      'a node calls an operation its profile does not have',
      await runDoc(
        harness,
        doc(
          call('chat.reply', {
            text: 'hi',
          }),
        ),
      ),
      [
        'CONNECTION_UNSATISFIED',
        'CONNECTION_INVALID',
      ],
    );
    expectCode(
      'a node waits for an event its entry does not declare',
      await runDoc(
        harness,
        doc({
          kind: 'wait',
          id: 'w',
          connection: 'app',
          event: 'deploy.failed',
          timeoutMs: 100,
        }),
      ),
      [
        'CONNECTION_UNSATISFIED',
        'CONNECTION_INVALID',
      ],
    );
    expectCode(
      'a malformed manifest entry (profile without a range)',
      await runDoc(
        harness,
        doc(
          call('ui.find', {
            query: 'x',
          }),
          {
            app: {
              profile: 'ui',
            },
          },
        ),
      ),
      [
        'CONNECTION_INVALID',
      ],
    );
    expectCode(
      'a manifest entry with an unknown field',
      await runDoc(
        harness,
        doc(
          call('ui.find', {
            query: 'x',
          }),
          {
            app: {
              profile: 'ui@^1',
              bogus: 1,
            },
          },
        ),
      ),
      [
        'CONNECTION_INVALID',
      ],
    );
    expectCode(
      'a verify matcher the grammar cannot parse',
      await runDoc(
        harness,
        doc({
          kind: 'verify',
          id: 'v',
          subject: 'app',
          expect: [
            {
              ui: '"unclosed',
            },
          ],
          act: [
            {
              'ui.tap': {
                element: 'button "Help"',
              },
            },
          ],
        }),
      ),
      [
        'VERIFY_INVALID',
      ],
    );
    expectCode(
      'a verify matcher on a sense the subject cannot perceive (net on a ui-only server)',
      await runDoc(
        harness,
        doc({
          kind: 'verify',
          id: 'v',
          subject: 'app',
          expect: [
            {
              net: 'POST /api/orders 201',
            },
          ],
          act: [
            {
              'ui.tap': {
                element: 'button "Help"',
              },
            },
          ],
        }),
      ),
      [
        'CONNECTION_UNSATISFIED',
      ],
    );
    expectCode(
      'a verify whose act has no operation with effects',
      await runDoc(
        harness,
        doc({
          kind: 'verify',
          id: 'v',
          subject: 'app',
          expect: [
            {
              ui: 'heading "Welcome"',
            },
          ],
          act: [
            {
              'ui.find': {
                query: 'x',
              },
            },
          ],
        }),
      ),
      [
        'VERIFY_INVALID',
      ],
    );
    expectCode(
      'a verify node on a harness with no verifier',
      await runDoc(
        noVerifier,
        doc({
          kind: 'verify',
          id: 'v',
          subject: 'app',
          expect: [
            {
              ui: 'heading "Welcome"',
            },
          ],
          act: [
            {
              'ui.tap': {
                element: 'button "Help"',
              },
            },
          ],
        }),
      ),
      [
        'VERIFY_NOT_CONFIGURED',
      ],
    );
    expectCode(
      'an op shorthand with no enclosing connection (two in the manifest)',
      await runDoc(
        harness,
        doc(
          {
            kind: 'sequence',
            id: 's',
            steps: [
              {
                'ui.tap': {
                  element: 'button "Help"',
                },
              },
            ],
          },
          {
            app: {
              profile: 'ui@^1',
            },
            other: {
              profile: 'ui@^1',
            },
          },
        ),
      ),
      [
        'CONNECTION_INVALID',
        'WORKFLOW_VALIDATION_FAILED',
        'CONNECTION_UNKNOWN',
      ],
    );
    const allow: ConnectionAllowlist = {
      app: {
        ops: [
          'ui.find',
          'ui.fill',
        ],
        secrets: {
          'app.password': 'ui.fill.text',
        },
      },
    };
    expectCode(
      'allowlist: a call on an operation the host does not allow',
      await runDoc(
        harness,
        doc(
          call('ui.tap', {
            element: 'button "Help"',
          }),
        ),
        allow,
      ),
      [
        'CONNECTION_NOT_ALLOWED',
      ],
    );
    expectCode(
      'allowlist: a secret used in a field other than the one it is bound to',
      await runDoc(
        harness,
        doc(
          call('ui.fill', {
            element: 'textbox "Email"',
            text: 'x',
            other: {
              $secret: 'app.password',
            },
          }),
        ),
        allow,
      ),
      [
        'CONNECTION_NOT_ALLOWED',
      ],
    );
    expectCode(
      'allowlist: a secret the host never granted',
      await runDoc(
        harness,
        doc(
          call('ui.fill', {
            element: 'textbox "Email"',
            text: {
              $secret: 'other.secret',
            },
          }),
        ),
        allow,
      ),
      [
        'CONNECTION_NOT_ALLOWED',
      ],
    );
    expectCode(
      'allowlist naming a connection the harness lacks',
      await runDoc(
        harness,
        doc(
          call('ui.find', {
            query: 'x',
          }),
        ),
        {
          ghost: {
            ops: [
              'ui.*',
            ],
          },
        },
      ),
      [
        'CONNECTION_UNKNOWN',
      ],
    );
    const okAllowed = await runDoc(
      harness,
      doc(
        call('ui.fill', {
          element: 'textbox "Password"',
          text: {
            $secret: 'app.password',
          },
        }),
      ),
      allow,
    );
    check('allowlist: a document within its grant runs', okAllowed.ok, show(okAllowed));
    expectCode(
      'a $-prefixed key that is not a value wrapper',
      await runDoc(
        harness,
        doc(
          call('ui.find', {
            query: {
              $bogus: 1,
            },
          }),
        ),
      ),
      [
        'WORKFLOW_VALIDATION_FAILED',
        'CONNECTION_INVALID',
      ],
    );
  } finally {
    await harness.closeConnections();
    await noVerifier.closeConnections();
  }
});

await section('dynamicWorkflow: a model writes the document', async () => {
  const written = {
    version: 1,
    connections: {
      app: {
        profile: 'ui@^1',
      },
    },
    root: {
      kind: 'call',
      id: 'find',
      connection: 'app',
      op: 'ui.find',
      args: {
        query: 'button',
      },
    },
  };
  const noRange = {
    ...written,
    connections: {
      app: {
        profile: 'ui',
      },
    },
  };
  const docs = [
    noRange,
    written,
  ];
  const model = startFakeModel((_input, _tools, round) => [
    message(JSON.stringify(docs[Math.min(round - 1, docs.length - 1)])),
  ]);
  const harness = new AgentHarness({
    name: 'qa-dynamic',
    params: {},
    connections: {
      app: server('dynamic'),
    },
    agentGraph: dynamicWorkflow({
      model: 'test/model',
      tools: [],
      maxRevisions: 2,
      connections: {
        app: {
          ops: [
            'ui.find',
          ],
        },
      },
    }),
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: model.baseUrl,
    },
  });
  try {
    await harness.execute('find the buttons', {
      threadId: 'dyn',
    });
    const response = await settle(
      harness.getAgentResponse({
        threadId: 'dyn',
      }),
    );
    check(
      'a dynamicWorkflow document over an allowed connection runs',
      response.ok,
      show(response),
    );
    const prompt = model.rounds[0]?.raw ?? '';
    check('the planner is shown the allowed connection and operation', prompt.includes('ui.find'));
    const plannerTools = model.rounds[0]?.toolNames ?? [];
    check(
      'the planner model is not handed connection tools beyond the allowlist (ops: [ui.find] only)',
      !plannerTools.some((t) => t.includes('ui_tap') || t.includes('ui_fill') || t === 'app_call'),
      plannerTools,
    );
    check(
      "the planner is shown the operation's argument schema (spec 35: 'with their argument schemas')",
      connectionsSection(prompt).includes('query'),
      prompt.slice(
        prompt.indexOf('Connections you may use'),
        prompt.indexOf('Connections you may use') + 700,
      ),
    );
    check(
      'a manifest entry the model wrote without a range is accepted (dynamicWorkflow fills in ranges itself)',
      model.rounds.length === 1,
      `planner rounds: ${model.rounds.length}; retry prompt: ${retryError(model.rounds[1]?.raw ?? '')}`,
    );
    check(
      'the planner prompt documents the verify node',
      prompt.includes('"kind": "verify"') || prompt.includes('\\"kind\\": \\"verify\\"'),
    );
  } finally {
    model.stop();
    await harness.closeConnections();
  }
});

await section('dynamicWorkflow: can the planner model drive a connection directly?', async () => {
  const doc = {
    version: 1,
    connections: {
      app: {
        profile: 'ui@^1',
      },
    },
    root: {
      kind: 'call',
      id: 'find',
      connection: 'app',
      op: 'ui.find',
      args: {
        query: 'button',
      },
    },
  };
  const model = startFakeModel((_input, _tools, round) =>
    round === 1
      ? [
          functionCall(
            'app_ui_tap',
            {
              element: 'button "Sign in"',
            },
            1,
          ),
        ]
      : [
          message(JSON.stringify(doc)),
        ],
  );
  const harness = new AgentHarness({
    name: 'qa-dynamic-bypass',
    params: {},
    connections: {
      app: server('dynamic-bypass'),
    },
    agentGraph: dynamicWorkflow({
      model: 'test/model',
      tools: [],
      maxRevisions: 1,
      connections: {
        app: {
          ops: [
            'ui.find',
          ],
        },
      },
    }),
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: model.baseUrl,
    },
  });
  try {
    await harness.execute('find the buttons', {
      threadId: 'bypass',
    });
    await settle(
      harness.getAgentResponse({
        threadId: 'bypass',
      }),
    );
    const taps = serverLog('dynamic-bypass').filter((c) => c.tool === 'ui.tap');
    check(
      'the planner model cannot run ui.tap, which the allowlist does not grant',
      taps.length === 0,
      taps,
    );
  } finally {
    model.stop();
    await harness.closeConnections();
  }
});

finish('json-workflow');
