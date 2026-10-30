/**
 * QA script 1 (specs 35, 36): a real MCP server over stdio that declares the
 * `ui@1` profile, connected with `mcp()`, driven through `step.call`,
 * `step.wait({ around })` and model-exposed tools with a scripted model.
 *
 * Run: `bun examples/connections/mcp-stdio.ts`. Exits non-zero when a check fails.
 */

import { join } from 'node:path';
import type { ContextData, SecretResolver, Step } from '@noetic-tools/core';
import { AgentHarness, callModel, connection, secret, step } from '@noetic-tools/core';
import { mcp } from '@noetic-tools/mcp';
import { z } from 'zod';
import { ui } from '../../packages/profile-ui/src/index';
import type { FakeReply } from './_fake-model';
import { functionCall, message, startFakeModel, toolOutputs } from './_fake-model';
import type { ServerCall } from './_qa';
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

const PASSWORD = 'hunter2-SECRET-9f3a';

const secrets: SecretResolver = {
  resolve: async (name) => {
    if (name === 'app.password') {
      return PASSWORD;
    }
    throw new Error(`no secret ${name}`);
  },
};

interface ServerOptions {
  readonly withProfiles?: boolean;
  readonly sensitiveSchema?: boolean;
}

function server(
  log: string,
  instance: string,
  { withProfiles = true, sensitiveSchema = false }: ServerOptions = {},
): ReturnType<typeof mcp> {
  return mcp({
    command: 'bun',
    args: [
      SERVER_PATH,
    ],
    env: {
      UI_SERVER_LOG: log,
      UI_SERVER_INSTANCE: instance,
      UI_SERVER_SENSITIVE_SCHEMA: sensitiveSchema ? '1' : '0',
    },
    ...(withProfiles
      ? {
          profiles: [
            ui,
          ],
        }
      : {}),
  });
}

function serverLog(path: string): ServerCall[] {
  return readServerLog(path);
}

type AnyStep = Step<ContextData, unknown, unknown>;

/** The spec's `const login = [...]` handed to `harness.run`, which the types refuse. */
function frameworkArray(steps: ReadonlyArray<unknown>): AnyStep {
  return z.custom<AnyStep>(() => true).parse(steps);
}

function asStep(value: unknown): AnyStep {
  return z.custom<AnyStep>(() => true).parse(value);
}

async function turn(harness: AgentHarness, input: string, threadId: string): Promise<string> {
  await harness.execute(input, {
    threadId,
  });
  const response = await harness.getAgentResponse({
    threadId,
  });
  return response.text;
}

//#endregion

const dir = scratchDir('mcp');
const log = join(dir, 'calls.jsonl');

await section('steps against a stdio ui@1 server', async () => {
  const harness = new AgentHarness({
    name: 'qa-mcp-steps',
    params: {},
    connections: {
      app: server(log, 'stdio-1'),
    },
    environment: {
      secrets,
    },
  });
  try {
    await harness.start();
    const status = harness.getConnectionStatus('app');
    check(
      'harness.start() connects the stdio server: state ready',
      status[0]?.state === 'ready',
      status,
    );
    check(
      'status carries the identity the server serves at noetic://identity',
      JSON.stringify(status).includes('stdio-1'),
      status,
    );

    const app = connection('app', ui);
    const ctx = harness.createContext();
    const login = [
      step.call({
        id: 'email',
        connection: app,
        op: 'ui.fill',
        args: {
          element: 'textbox "Email"',
          text: 'qa@example.com',
        },
      }),
      step.call({
        id: 'password',
        connection: app,
        op: 'ui.fill',
        args: {
          element: 'textbox "Password"',
          text: secret('app.password'),
        },
      }),
      step.call({
        id: 'look',
        connection: app,
        op: 'ui.describe',
        args: {},
      }),
    ];
    // `harness.run` takes one Step; an array is rejected by the types. At run time:
    const asArray = await settle(
      harness.run(frameworkArray(login), undefined, harness.createContext()),
    );
    check(
      'harness.run(array) runs the array in sequence (spec 35: an array runs its steps in sequence)',
      asArray.ok,
      show(asArray),
    );
    const fills = await settle(
      (async (): Promise<unknown> => {
        let last: unknown;
        for (const s of login) {
          last = await harness.run(asStep(s), undefined, ctx);
        }
        return last;
      })(),
    );
    check('the login steps run one by one', fills.ok, show(fills));
    const calls = serverLog(log);
    const passwordCall = calls.find(
      (c) => c.tool === 'ui.fill' && c.args.element === 'textbox "Password"',
    );
    check(
      'the secret reached the server resolved',
      passwordCall?.args.text === PASSWORD,
      passwordCall,
    );
    check(
      'every call carries _meta["tools.noetic/idempotency-key"]',
      calls.length > 0 &&
        calls.every((c) => typeof c.meta['tools.noetic/idempotency-key'] === 'string'),
      calls.map((c) => c.meta),
    );
    const describeOut = JSON.stringify(fills.ok ? fills.value : null);
    check(
      'a resolved secret echoed back in an output is replaced with <redacted>',
      !describeOut.includes(PASSWORD) && describeOut.includes('<redacted>'),
      describeOut,
    );
    const logged = JSON.stringify(ctx.itemLog.items);
    check('the secret never appears in the item log', !logged.includes(PASSWORD));
    check('the run recorded step meta', ctx.lastStepMeta !== undefined);

    const ambiguous = await settle(
      harness.run(
        step.call({
          id: 'ambiguous',
          connection: app,
          op: 'ui.tap',
          args: {
            element: 'button',
          },
        }),
        undefined,
        harness.createContext(),
      ),
    );
    check(
      'an ambiguous locator fails with connection_failed, error.code ambiguous',
      !ambiguous.ok &&
        ambiguous.kind === 'connection_failed' &&
        ambiguous.message.includes('ambiguous'),
      show(ambiguous),
    );

    const badArgs = await settle(
      harness.run(
        step.call({
          id: 'bad-args',
          connection: 'app',
          op: 'ui.tap',
          args: {
            nope: true,
          },
        }),
        undefined,
        harness.createContext(),
      ),
    );
    check(
      'args that do not match the operation schema are refused before sending',
      !badArgs.ok,
      show(badArgs),
    );
    check(
      'the refused call never reached the server',
      !serverLog(log).some((c) => c.args.nope === true),
      serverLog(log).filter((c) => c.args.nope === true),
    );

    const secretInPlainField = await settle(
      harness.run(
        step.call({
          id: 'secret-tap',
          connection: 'app',
          op: 'ui.tap',
          args: {
            element: secret('app.password'),
          },
        }),
        undefined,
        harness.createContext(),
      ),
    );
    check(
      'a secret outside a sensitive field fails with connection_secret_refused',
      !secretInPlainField.ok && secretInPlainField.kind === 'connection_secret_refused',
      show(secretInPlainField),
    );

    const unknownOp = await settle(
      harness.run(
        step.call({
          id: 'unknown-op',
          connection: 'app',
          op: 'ui.teleport',
          args: {},
        }),
        undefined,
        harness.createContext(),
      ),
    );
    check('an operation the connection does not offer is refused', !unknownOp.ok, show(unknownOp));

    const waited = await settle(
      harness.run(
        step.wait({
          id: 'signed-in',
          connection: app,
          event: 'ui.changed',
          filter: (e) => JSON.stringify(e.payload).includes('Welcome'),
          around: step.call({
            id: 'sign-in',
            connection: app,
            op: 'ui.tap',
            args: {
              element: 'button "Sign in"',
            },
          }),
          timeoutMs: 5e3,
        }),
        undefined,
        harness.createContext(),
      ),
    );
    check('step.wait({ around }) catches the event the action causes', waited.ok, show(waited));
    const waitedValue = waited.ok ? JSON.stringify(waited.value) : '';
    check(
      "step.wait's output is { event, around }",
      waitedValue.includes('"event"') &&
        waitedValue.includes('"around"') &&
        waitedValue.includes('receipt'),
      waitedValue,
    );
    check(
      'the event is stamped with the harness connection name',
      waitedValue.includes('"connection":"app"'),
      waitedValue,
    );

    const timeout = await settle(
      harness.run(
        step.wait({
          id: 'never-comes',
          connection: app,
          event: 'ui.changed',
          filter: () => false,
          timeoutMs: 300,
        }),
        undefined,
        harness.createContext(),
      ),
    );
    check('a wait whose event never comes fails after timeoutMs', !timeout.ok, show(timeout));

    const unknownConn = await settle(
      harness.run(
        step.call({
          id: 'nowhere',
          connection: 'nowhere',
          op: 'ui.tap',
          args: {
            element: 'button "Help"',
          },
        }),
        undefined,
        harness.createContext(),
      ),
    );
    check(
      'a call naming a connection the harness lacks fails with CONNECTION_UNKNOWN',
      !unknownConn.ok && unknownConn.code === 'CONNECTION_UNKNOWN',
      show(unknownConn),
    );
  } finally {
    await harness.close();
  }
});

await section('secrets through a server that publishes text as sensitive itself', async () => {
  const sensitiveLog = join(dir, 'sensitive.jsonl');
  const harness = new AgentHarness({
    name: 'qa-mcp-secrets',
    params: {},
    connections: {
      app: server(sensitiveLog, 'stdio-sensitive', {
        sensitiveSchema: true,
      }),
    },
    environment: {
      secrets,
    },
  });
  try {
    const ctx = harness.createContext();
    const fill = await settle(
      harness.run(
        step.call({
          id: 'password',
          connection: 'app',
          op: 'ui.fill',
          args: {
            element: 'textbox "Password"',
            text: secret('app.password'),
          },
        }),
        undefined,
        ctx,
      ),
    );
    check('ui.fill with secret() passes the gates', fill.ok, show(fill));
    const sent = serverLog(sensitiveLog).find((c) => c.tool === 'ui.fill');
    check('the secret reached the server resolved', sent?.args.text === PASSWORD, sent);
    const described = await settle(
      harness.run(
        step.call({
          id: 'look',
          connection: 'app',
          op: 'ui.describe',
          args: {},
        }),
        undefined,
        ctx,
      ),
    );
    const out = JSON.stringify(described.ok ? described.value : null);
    check(
      'a resolved secret echoed back in an output is replaced with <redacted>',
      described.ok && !out.includes(PASSWORD) && out.includes('<redacted>'),
      out,
    );
    const b64 = Buffer.from(PASSWORD).toString('base64');
    check(
      'neither the secret nor its base64 form is in the item log',
      !JSON.stringify(ctx.itemLog.items).includes(PASSWORD) &&
        !JSON.stringify(ctx.itemLog.items).includes(b64),
    );
  } finally {
    await harness.close();
  }
});

await section('the same server without a profile catalog (spec 35 quick start)', async () => {
  const harness = new AgentHarness({
    name: 'qa-mcp-plain',
    params: {},
    connections: {
      app: server(join(dir, 'plain.jsonl'), 'stdio-plain', {
        withProfiles: false,
      }),
    },
  });
  try {
    await harness.start();
    const status = harness.getConnectionStatus('app');
    check(
      'mcp() with no profiles option still connects a declaring server',
      status[0]?.state === 'ready',
      status,
    );
    const out = await settle(
      harness.run(
        step.call({
          id: 'tap',
          connection: 'app',
          op: 'ui.tap',
          args: {
            element: 'button "Help"',
          },
        }),
        undefined,
        harness.createContext(),
      ),
    );
    check('step.call works without the catalog', out.ok, show(out));
  } finally {
    await harness.close();
  }
});

await section('model-exposed tools with a scripted model', async () => {
  const modelLog = join(dir, 'model.jsonl');
  const script: FakeReply = (input, _tools, round) => {
    const outputs = toolOutputs(input);
    if (round === 1) {
      return [
        functionCall(
          'app_ui_fill',
          {
            element: 'textbox "Email"',
            text: 'model@example.com',
          },
          1,
        ),
      ];
    }
    if (round === 2) {
      return [
        functionCall(
          'app_call',
          {
            op: 'ui.key',
            args: {
              key: 'Enter',
            },
          },
          2,
        ),
      ];
    }
    if (round === 3) {
      return [
        functionCall(
          'app_ui_tap',
          {
            element: 'button',
          },
          3,
        ),
      ];
    }
    return [
      message(`done after ${outputs.length} tool results`),
    ];
  };
  const model = startFakeModel(script);
  const harness = new AgentHarness({
    name: 'qa-mcp-model',
    params: {},
    connections: {
      app: server(modelLog, 'stdio-model'),
    },
    agentGraph: callModel({
      id: 'agent',
      model: 'test/model',
      instructions: 'Use the app.',
    }),
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: model.baseUrl,
    },
  });
  try {
    const answer = await settle(turn(harness, 'Sign in please', 'model-thread'));
    check('a model turn over a connection completes', answer.ok, show(answer));
    const first = model.rounds[0];
    const names = first?.toolNames ?? [];
    console.log(`      tools offered: ${names.join(', ')}`);
    const expected = [
      'app_call',
      'app_ops',
      'app_ui_describe',
      'app_ui_fill',
      'app_ui_find',
      'app_ui_settle',
      'app_ui_tap',
    ];
    check(
      "expose 'eager' offers ui@1's eager operations plus app_ops and app_call",
      expected.every((n) => names.includes(n)),
      names,
    );
    check(
      'non-eager operations (ui.type, ui.key, ui.scroll) are not their own tools',
      !names.includes('app_ui_key'),
      names,
    );
    const calls = serverLog(modelLog);
    check(
      'the model tool call reached the server',
      calls.some((c) => c.tool === 'ui.fill' && c.args.text === 'model@example.com'),
      calls,
    );
    check(
      '<name>_call runs a non-eager operation',
      calls.some((c) => c.tool === 'ui.key'),
      calls,
    );
    const round4 = model.rounds[3];
    const errOut = round4 === undefined ? [] : toolOutputs(round4.input);
    check(
      'a refused model call returns a tool error to the model (not a crash)',
      errOut.some((o) => o.output.includes('ambiguous')),
      errOut,
    );
    const sawSummary = (first?.raw ?? '').includes('textbox');
    check(
      "the ui.summary read (look: 'turn') reaches the model's context",
      sawSummary,
      (first?.raw ?? '').slice(0, 800),
    );
  } finally {
    model.stop();
    await harness.close();
  }
});

await section('two connections offering ui@1 share one tool with a target argument', async () => {
  const model = startFakeModel(() => [
    message('nothing to do'),
  ]);
  const harness = new AgentHarness({
    name: 'qa-mcp-collide',
    params: {},
    connections: {
      ios: server(join(dir, 'ios.jsonl'), 'ios-1'),
      android: server(join(dir, 'android.jsonl'), 'android-1'),
    },
    agentGraph: callModel({
      id: 'agent',
      model: 'test/model',
    }),
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: model.baseUrl,
    },
  });
  try {
    const answer = await settle(turn(harness, 'hi', 'collide'));
    check('a turn with two ui@1 connections completes', answer.ok, show(answer));
    const names = model.rounds[0]?.toolNames ?? [];
    console.log(`      tools offered: ${names.join(', ')}`);
    check(
      'one ui_tap tool, not ios_ui_tap and android_ui_tap',
      names.includes('ui_tap') && !names.includes('ios_ui_tap'),
      names,
    );
    const raw = model.rounds[0]?.raw ?? '';
    check('the merged tool has a target argument', raw.includes('"target"'), '');
  } finally {
    model.stop();
    await harness.close();
  }
});

await section('a server that contradicts its declaration is unavailable', async () => {
  const harness = new AgentHarness({
    name: 'qa-mcp-broken',
    params: {},
    connections: {
      broken: mcp({
        command: 'bun',
        args: [
          '-e',
          'process.exit(3)',
        ],
        timeoutMs: 3e3,
      }),
      app: server(join(dir, 'ok.jsonl'), 'ok-1'),
    },
  });
  try {
    const started = await settle(harness.start());
    const status = harness.getConnectionStatus();
    console.log(`      start: ${show(started)}`);
    check(
      'a server that cannot start is marked unavailable and others keep working',
      status.some((s) => s.name === 'broken' && s.state === 'unavailable') &&
        status.some((s) => s.name === 'app' && s.state === 'ready'),
      status,
    );
    const call = await settle(
      harness.run(
        step.call({
          id: 'x',
          connection: 'broken',
          op: 'ui.tap',
          args: {
            element: 'button "Help"',
          },
        }),
        undefined,
        harness.createContext(),
      ),
    );
    check(
      'a step on the unavailable connection fails with connection_unavailable',
      !call.ok && call.kind === 'connection_unavailable',
      show(call),
    );
  } finally {
    await harness.close();
  }
});

await section('policy gates and secrets sent by the model', async () => {
  const gateLog = join(dir, 'gates.jsonl');
  const model = startFakeModel((_input, _tools, round) =>
    round === 1
      ? [
          functionCall(
            'app_ui_fill',
            {
              element: 'textbox "Password"',
              text: {
                $secret: 'app.password',
              },
            },
            1,
          ),
        ]
      : [
          message('done'),
        ],
  );
  const harness = new AgentHarness({
    name: 'qa-mcp-policy',
    params: {},
    connections: {
      app: {
        provider: server(gateLog, 'stdio-policy', {
          sensitiveSchema: true,
        }),
        policy: {
          deny: [
            'ui.key',
          ],
          approve: [
            'ui.tap',
          ],
        },
      },
    },
    environment: {
      secrets,
    },
    agentGraph: callModel({
      id: 'agent',
      model: 'test/model',
    }),
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: model.baseUrl,
    },
  });
  try {
    const denied = await settle(
      harness.run(
        step.call({
          id: 'key',
          connection: 'app',
          op: 'ui.key',
          args: {
            key: 'Enter',
          },
        }),
        undefined,
        harness.createContext(),
      ),
    );
    check(
      'a policy-denied operation fails the step with steering_denied',
      !denied.ok && denied.kind === 'steering_denied',
      show(denied),
    );
    const unapproved = await settle(
      harness.run(
        step.call({
          id: 'tap',
          connection: 'app',
          op: 'ui.tap',
          args: {
            element: 'button "Help"',
          },
        }),
        undefined,
        harness.createContext(),
      ),
    );
    check(
      'an operation the policy says needs approval, with no approver, fails with steering_denied',
      !unapproved.ok && unapproved.kind === 'steering_denied',
      show(unapproved),
    );
    check(
      'neither refused call reached the server',
      !serverLog(gateLog).some((c) => c.tool === 'ui.key' || c.tool === 'ui.tap'),
      serverLog(gateLog),
    );
    const answer = await settle(turn(harness, 'log in', 'policy-thread'));
    check('the model turn completes', answer.ok, show(answer));
    const outputs = toolOutputs(model.rounds[1]?.input ?? []);
    check(
      'a secret sent by the model is refused (connection_secret_refused) as a tool error',
      outputs.some((o) => o.output.includes('secret')),
      outputs,
    );
    check(
      'the model-sent secret never reached the server',
      !serverLog(gateLog).some((c) => c.tool === 'ui.fill'),
      serverLog(gateLog),
    );
  } finally {
    model.stop();
    await harness.close();
  }
});

finish('mcp-stdio');
