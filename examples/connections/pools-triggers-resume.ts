/**
 * QA script 4 (spec 35): pools with `fresh: 'path'` across parallel paths,
 * triggers from `defineSource()` and `cron()`, secret scrubbing in traces, and
 * resume after an interrupted call under the free / costly / unsafe rules of
 * § Durability.
 *
 * Run: `bun examples/connections/pools-triggers-resume.ts`. Exits non-zero when a check fails.
 */

import type {
  ConnectionHandle,
  ContextData,
  InMemoryConnectionOptions,
  InMemoryConnectionProvider,
  SecretResolver,
  Span,
  Step,
  TraceExporter,
} from '@noetic-tools/core';
import {
  AgentHarness,
  callModel,
  connection,
  createCheckpointStore,
  createInMemoryConnection,
  createInMemoryStorage,
  cron,
  defineSource,
  inParallel,
  loop,
  runCode,
  secret,
  step,
  until,
} from '@noetic-tools/core';
import { z } from 'zod';
import { message, startFakeModel } from './_fake-model';
import { check, finish, section, settle, show, sleep } from './_qa';

//#region Fixtures

type Storage = ReturnType<typeof createInMemoryStorage>;

/** `Determinism` is not re-exported from `@noetic-tools/core`; derive it. */
type Determinism = NonNullable<InMemoryConnectionOptions['determinism']>;

type AnyStep = Step<ContextData, unknown, unknown>;

interface CallLog {
  readonly connection: string;
  readonly op: string;
  readonly key: string;
}

function receipt(): Record<string, unknown> {
  return {
    actionId: `a-${crypto.randomUUID()}`,
    cursor: null,
  };
}

function browserOptions(log: CallLog[], id: string): InMemoryConnectionOptions {
  return {
    id,
    operations: {
      'ui.tap': {
        effects: true,
        run: async (_args, call) => {
          log.push({
            connection: call.connection.id,
            op: 'ui.tap',
            key: call.idempotencyKey,
          });
          await sleep(60);
          return {
            by: call.connection.id,
            receipt: receipt(),
          };
        },
      },
    },
  };
}

function browserPool(log: CallLog[]): InMemoryConnectionProvider {
  let n = 0;
  return createInMemoryConnection({
    ...browserOptions(log, 'pool-root'),
    provision: () => {
      n++;
      return browserOptions(log, `browser-${n}`);
    },
  });
}

function tapOn(handle: ConnectionHandle<undefined>, id: string): AnyStep {
  return step.call({
    id,
    connection: handle,
    op: 'ui.tap',
    args: {
      element: 'button "Go"',
    },
  });
}

interface Recorded {
  readonly threadId: string;
  readonly input: string;
  readonly items: string;
}

/** An agent graph with no model: it records each turn's input and item log. */
function recorder(): {
  turns: Recorded[];
  graph: ReturnType<typeof runCode<ContextData, string, string>>;
} {
  const turns: Recorded[] = [];
  return {
    turns,
    graph: runCode<ContextData, string, string>({
      id: 'recorder',
      execute: async (input, ctx): Promise<string> => {
        turns.push({
          threadId: ctx.threadId,
          input: JSON.stringify(input),
          items: JSON.stringify(ctx.itemLog.items),
        });
        return 'recorded';
      },
    }),
  };
}

//#endregion

await section('pools: fresh per parallel path', async () => {
  const log: CallLog[] = [];
  const pool = browserPool(log);
  const harness = new AgentHarness({
    name: 'qa-pool',
    params: {},
    connections: {
      browsers: {
        provider: pool,
        pool: {
          max: 2,
          waitMs: 2e3,
        },
      },
    },
  });
  try {
    const app = connection('app', undefined, {
      from: 'browsers',
      fresh: 'path',
      setup: {
        url: 'http://localhost:5173/login',
      },
    });
    const flow = (n: number): AnyStep =>
      loop({
        id: `flow-${n}`,
        steps: [
          tapOn(app, `flow-${n}-a`),
          tapOn(app, `flow-${n}-b`),
        ],
        until: until.maxSteps(1),
      });
    const out = await settle(
      harness.run(
        inParallel({
          id: 'suite',
          mode: 'all',
          paths: () => [
            flow(1),
            flow(2),
          ],
          merge: (results) => results,
        }),
        undefined,
        harness.createContext(),
      ),
    );
    check('two parallel paths over a fresh:path handle run', out.ok, show(out));
    const used = new Set(log.map((l) => l.connection));
    console.log(`      calls: ${log.map((l) => l.connection).join(', ')}`);
    check(
      'each path got its own fresh connection (2 distinct)',
      used.size === 2 && !used.has('pool-root'),
      [
        ...used,
      ],
    );
    check(
      'the pool provisioned exactly two',
      pool.provisioned.length === 2,
      pool.provisioned.length,
    );
    check(
      'setup was passed to the provider',
      pool.provisioned.every((c) => c.setupGiven?.url === 'http://localhost:5173/login'),
      pool.provisioned.map((c) => c.setupGiven),
    );
    const byConnection = new Map<string, number>();
    for (const l of log) {
      byConnection.set(l.connection, (byConnection.get(l.connection) ?? 0) + 1);
    }
    check(
      "both steps of one path share that path's connection",
      [
        ...byConnection.values(),
      ].every((n) => n === 2),
      Object.fromEntries(byConnection),
    );
    await sleep(50);
    check(
      'leases are given back when the run ends',
      pool.provisioned.every((c) => c.released),
      pool.provisioned.map((c) => c.released),
    );
    const status = harness.getConnectionStatus('browsers');
    console.log(`      status: ${JSON.stringify(status)}`);
  } finally {
    await harness.close();
  }
});

await section('pools: fresh per run, and a full pool past waitMs', async () => {
  const log: CallLog[] = [];
  const pool = browserPool(log);
  const harness = new AgentHarness({
    name: 'qa-pool-run',
    params: {},
    connections: {
      browsers: {
        provider: pool,
        pool: {
          max: 1,
          waitMs: 20,
        },
      },
    },
  });
  try {
    const run = connection('app', undefined, {
      from: 'browsers',
      fresh: 'run',
    });
    const seq = await settle(
      harness.run(
        loop({
          id: 'seq',
          steps: [
            tapOn(run, 'r1'),
            tapOn(run, 'r2'),
          ],
          until: until.maxSteps(1),
        }),
        undefined,
        harness.createContext(),
      ),
    );
    check('fresh:run runs', seq.ok, show(seq));
    check(
      'every step of the run shares one connection',
      new Set(log.map((l) => l.connection)).size === 1,
      log,
    );

    const path = connection('app', undefined, {
      from: 'browsers',
      fresh: 'path',
    });
    const full = await settle(
      harness.run(
        inParallel({
          id: 'too-many',
          mode: 'all',
          paths: () => [
            tapOn(path, 'p1'),
            tapOn(path, 'p2'),
          ],
          merge: (results) => results,
        }),
        undefined,
        harness.createContext(),
      ),
    );
    check(
      'a pool of 1 with two parallel paths and waitMs 20: the second path fails with connection_unavailable',
      !full.ok && full.message.includes('connection_unavailable'),
      show(full),
    );
  } finally {
    await harness.close();
  }
});

await section('triggers: defineSource', async () => {
  const DeployFailed = z.object({
    service: z.string(),
    bot: z.boolean(),
  });
  const deploys = defineSource({
    events: {
      'deploy.failed': DeployFailed,
    },
  });
  const agent = recorder();
  const harness = new AgentHarness({
    name: 'qa-triggers',
    params: {},
    connections: {
      deploys,
    },
    triggers: [
      {
        id: 'deploy-alerts',
        connection: 'deploys',
        event: 'deploy.failed',
        filter: (e) => !DeployFailed.parse(e.payload).bot,
        input: (e) => `Deploy failed: ${DeployFailed.parse(e.payload).service}`,
      },
    ],
    agentGraph: agent.graph,
  });
  try {
    await harness.start();
    await deploys.emit({
      type: 'deploy.failed',
      id: 'd-1',
      payload: {
        service: 'checkout',
        bot: false,
      },
    });
    await deploys.emit({
      type: 'deploy.failed',
      id: 'd-1',
      payload: {
        service: 'checkout',
        bot: false,
      },
    });
    await deploys.emit({
      type: 'deploy.failed',
      id: 'd-2',
      payload: {
        service: 'bots',
        bot: true,
      },
    });
    await sleep(500);
    const inputs = agent.turns.map((t) => `${t.input} ${t.items}`);
    check(
      'a matching event starts a turn with input(event)',
      inputs.some((i) => i.includes('Deploy failed: checkout')),
      inputs,
    );
    check('the same event id is delivered once', agent.turns.length === 1, agent.turns.length);
    check('the filter drops events it rejects', !inputs.some((i) => i.includes('bots')));
    check(
      'the turn runs on the trigger id thread by default',
      agent.turns[0]?.threadId === 'deploy-alerts',
      agent.turns.map((t) => t.threadId),
    );
    check(
      'the message id is <connection>:<trigger>:<event id>',
      agent.turns[0]?.items.includes('deploys:deploy-alerts:d-1') === true,
      agent.turns[0]?.items.slice(0, 400),
    );
    const response = await settle(
      harness.getAgentResponse({
        threadId: 'deploy-alerts',
      }),
    );
    check('getAgentResponse on that thread answers', response.ok, show(response));
    const items = response.ok ? JSON.stringify(response.value) : '';
    check(
      'the event is attached as a noetic:connection_event item',
      inputs.some((i) => i.includes('connection_event')) ||
        items.includes('noetic:connection_event'),
      inputs[0]?.slice(0, 500),
    );
    const bad = await settle(
      deploys.emit(
        z
          .custom<Parameters<typeof deploys.emit>[0]>(() => true)
          .parse({
            type: 'deploy.failed',
            id: 'd-3',
            payload: {
              service: 42,
              bot: false,
            },
          }),
      ),
    );
    check('an event that does not match its schema is refused by emit', !bad.ok, show(bad));
  } finally {
    await harness.close();
  }

  const unknown = await settle(
    (async (): Promise<unknown> =>
      new AgentHarness({
        name: 'qa-trigger-unknown',
        params: {},
        connections: {
          deploys,
        },
        triggers: [
          {
            id: 't',
            connection: 'nowhere',
            event: 'deploy.failed',
            input: () => 'x',
          },
        ],
      }))(),
  );
  check(
    'a trigger naming an unknown connection fails with CONNECTION_UNKNOWN',
    !unknown.ok && unknown.code === 'CONNECTION_UNKNOWN',
    show(unknown),
  );
});

await section('triggers: a trigger turn reaching a model agent', async () => {
  const deploys = defineSource({
    events: {
      'deploy.failed': z.object({
        service: z.string(),
      }),
    },
  });
  const model = startFakeModel(() => [
    message('on it'),
  ]);
  const harness = new AgentHarness({
    name: 'qa-trigger-model',
    params: {},
    connections: {
      deploys,
    },
    triggers: [
      {
        id: 'deploy-alerts',
        connection: 'deploys',
        event: 'deploy.failed',
        input: () => 'Deploy failed: checkout',
      },
    ],
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
    await harness.start();
    await deploys.emit({
      type: 'deploy.failed',
      id: 'd-1',
      payload: {
        service: 'checkout',
      },
    });
    const response = await settle(
      harness.getAgentResponse({
        threadId: 'deploy-alerts',
      }),
    );
    check(
      'a trigger turn on a callModel agent reaches the model (the noetic:connection_event item must not break the request)',
      response.ok && model.rounds.length === 1,
      show(response).slice(0, 300),
    );
  } finally {
    model.stop();
    await harness.close();
  }
});

await section('triggers: cron delivers the ticks it missed while down', async () => {
  const storage = createInMemoryStorage();
  const minute = 6e4;
  const lastSeen = new Date(Math.floor(Date.now() / minute) * minute - 3 * minute).toISOString();
  await storage.set('noetic/connections/triggers/daily/cursor', lastSeen);
  const agent = recorder();
  const harness = new AgentHarness({
    name: 'qa-cron',
    params: {},
    connections: {
      morning: cron('* * * * *', {
        timezone: 'America/New_York',
      }),
    },
    triggers: [
      {
        id: 'daily',
        connection: 'morning',
        event: 'tick',
        input: (e) => `Write the summary for ${JSON.stringify(e.payload)}`,
      },
    ],
    agentGraph: agent.graph,
    environment: {
      storage: {
        adapter: storage,
      },
    },
  });
  try {
    await harness.start();
    await sleep(1500);
    console.log(
      `      cursor was ${lastSeen}; ticks seen per turn: ${agent.turns
        .map((t) =>
          [
            ...new Set(
              [
                ...t.items.matchAll(/scheduledFor[^0-9]*([0-9T:.-]+Z)/g),
              ].map((m) => m[1]?.slice(11, 16)),
            ),
          ].join(','),
        )
        .join(' | ')}; now ${new Date().toISOString()}`,
    );
    check(
      'each missed minute is delivered as its own turn (3)',
      agent.turns.length === 3,
      agent.turns.length,
    );
    const cursor = await storage.get('noetic/connections/triggers/daily/cursor');
    check('the cursor advanced', typeof cursor === 'string' && cursor > lastSeen, cursor);
    const bad = await settle((async (): Promise<unknown> => cron('61 * * * *'))());
    check(
      'a malformed schedule fails with CONNECTION_INVALID',
      !bad.ok && bad.code === 'CONNECTION_INVALID',
      show(bad),
    );
  } finally {
    await harness.close();
  }
});

await section('secret scrubbing in outputs, events and traces', async () => {
  const PASSWORD = 's3cr3t-TRACE-4242';
  const spans: Span[] = [];
  const exporter: TraceExporter = {
    export: async (batch) => {
      spans.push(...batch);
    },
  };
  const secrets: SecretResolver = {
    resolve: async () => PASSWORD,
  };
  const echo = createInMemoryConnection({
    events: {
      'ui.changed': {
        sense: 'ui',
        replay: 'live',
      },
    },
    operations: {
      'ui.fill': {
        effects: true,
        inputSchema: {
          type: 'object',
          properties: {
            element: {
              type: 'string',
            },
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
        },
        run: (args, call) => {
          const text = z
            .object({
              text: z.string(),
            })
            .parse(args).text;
          call.connection.emit('ui.changed', {
            summary: `textbox "Password" = ${text}`,
            b64: Buffer.from(text).toString('base64'),
            url: `https://x.test/?p=${encodeURIComponent(text)}`,
          });
          return {
            echoed: text,
            receipt: receipt(),
          };
        },
      },
    },
  });
  const harness = new AgentHarness({
    name: 'qa-secrets',
    params: {},
    connections: {
      app: echo,
    },
    environment: {
      secrets,
    },
    traceExporter: exporter,
  });
  try {
    const ctx = harness.createContext();
    const out = await settle(
      harness.run(
        step.wait({
          id: 'changed',
          connection: 'app',
          event: 'ui.changed',
          around: step.call({
            id: 'fill',
            connection: 'app',
            op: 'ui.fill',
            args: {
              element: 'textbox "Password"',
              text: secret('app.password'),
            },
          }),
          timeoutMs: 2e3,
        }),
        undefined,
        ctx,
      ),
    );
    check('the fill and its event complete', out.ok, show(out));
    const text = JSON.stringify(out.ok ? out.value : null);
    const b64 = Buffer.from(PASSWORD).toString('base64');
    const enc = encodeURIComponent(PASSWORD);
    check(
      'the call reached the connection resolved',
      echo.connection.calls.some((c) => JSON.stringify(c.args).includes(PASSWORD)),
    );
    check(
      'the output and event have the secret replaced',
      !text.includes(PASSWORD) && text.includes('<redacted>'),
      text,
    );
    check('the base64 form is scrubbed too', !text.includes(b64), text);
    check('the URL-encoded form is scrubbed too', !text.includes(enc) || enc === PASSWORD, text);
    await sleep(100);
    const traced = JSON.stringify(spans);
    console.log(`      spans exported: ${spans.length}`);
    check(
      'no exported span contains the secret',
      !traced.includes(PASSWORD) && !traced.includes(b64),
    );
    check(
      'the item log never holds the secret',
      !JSON.stringify(ctx.itemLog.items).includes(PASSWORD),
    );
  } finally {
    await harness.close();
  }
});

//#region Resume

type Replay = Determinism['replayPrefix'];

interface ResumeRig {
  readonly calls: CallLog[];
  readonly resets: string[];
  hang: boolean;
}

function determinism(replayPrefix: Replay): Determinism {
  return {
    reset: replayPrefix === 'unsafe' ? 'none' : 'cheap',
    replayPrefix,
    time: 'wall',
    observation: 'exact',
    actions: replayPrefix === 'unsafe' ? 'irreversible' : 'reversible',
  };
}

function resumable(rig: ResumeRig, replay: Replay, id: string): InMemoryConnectionProvider {
  return createInMemoryConnection({
    id,
    // The thing driven: the same instance across a reconnect, a new one when replaced.
    instance: id,
    determinism: determinism(replay),
    reset: () => {
      rig.resets.push(id);
    },
    operations: {
      'ui.fill': {
        effects: true,
        once: true,
        run: (_args, call) => {
          rig.calls.push({
            connection: call.connection.id,
            op: 'ui.fill',
            key: call.idempotencyKey,
          });
          return {
            receipt: receipt(),
          };
        },
      },
      'ui.tap': {
        effects: true,
        run: async (_args, call) => {
          rig.calls.push({
            connection: call.connection.id,
            op: 'ui.tap',
            key: call.idempotencyKey,
          });
          if (rig.hang) {
            await new Promise(() => undefined);
          }
          return {
            receipt: receipt(),
          };
        },
      },
    },
  });
}

function graph(): AnyStep {
  return loop({
    id: 'flow',
    steps: [
      step.call({
        id: 'fill',
        connection: 'app',
        op: 'ui.fill',
        args: {
          element: 'textbox "Email"',
          text: 'qa@example.com',
        },
      }),
      step.call({
        id: 'tap',
        connection: 'app',
        op: 'ui.tap',
        args: {
          element: 'button "Sign in"',
        },
      }),
    ],
    until: until.maxSteps(1),
  });
}

function durable(storage: Storage, app: InMemoryConnectionProvider): AgentHarness {
  return new AgentHarness({
    name: 'qa-resume',
    params: {},
    connections: {
      app,
    },
    environment: {
      storage: {
        adapter: storage,
        checkpointStore: createCheckpointStore({
          storage,
        }),
      },
    },
  });
}

/** Runs the graph until `ui.tap` is in flight, then abandons that harness, as a crash would. */
async function interrupt(
  storage: Storage,
  rig: ResumeRig,
  first: InMemoryConnectionProvider,
): Promise<string> {
  const harness = durable(storage, first);
  const ctx = harness.createContext();
  void harness.run(graph(), 'go', ctx).catch(() => undefined);
  for (let i = 0; i < 200 && !rig.calls.some((c) => c.op === 'ui.tap'); i++) {
    await sleep(10);
  }
  rig.hang = false;
  return ctx.id;
}

async function resumeCase(replay: Replay, replaced: boolean): Promise<void> {
  const label = `${replay}${replaced ? ', replaced' : ', same identity'}`;
  const rig: ResumeRig = {
    calls: [],
    resets: [],
    hang: true,
  };
  const storage = createInMemoryStorage();
  const first = resumable(rig, replay, 'first');
  const executionId = await interrupt(storage, rig, first);
  check(
    `${label}: the first attempt left ui.tap in flight`,
    rig.calls.some((c) => c.op === 'ui.tap'),
    rig.calls,
  );
  const firstKeys = Object.fromEntries(
    rig.calls.map((c) => [
      c.op,
      c.key,
    ]),
  );
  const second = replaced ? resumable(rig, replay, 'second') : first;
  const harness = durable(storage, second);
  try {
    const restored = await harness.restore(executionId);
    check(`${label}: restore() finds the interrupted execution`, restored !== null);
    if (restored === null) {
      return;
    }
    const before = rig.calls.length;
    const out = await settle(harness.run(graph(), 'go', restored));
    const after = rig.calls.slice(before);
    console.log(
      `      ${label}: ${show(out).slice(0, 200)}; calls after resume: ${JSON.stringify(after)}; resets: ${rig.resets}`,
    );
    if (!replaced) {
      check(`${label}: the resumed run completes`, out.ok, show(out));
      check(
        `${label}: ui.fill (recorded) is not sent again`,
        !after.some((c) => c.op === 'ui.fill'),
        after,
      );
      check(
        `${label}: ui.tap (pending) is re-sent with the same idempotency key`,
        after.some((c) => c.op === 'ui.tap' && c.key === firstKeys['ui.tap']),
        {
          firstKeys,
          after,
        },
      );
      return;
    }
    if (replay === 'unsafe') {
      check(
        `${label}: the resumed run stops with connection_resume_refused`,
        !out.ok && out.kind === 'connection_resume_refused',
        show(out),
      );
      check(`${label}: nothing was sent to the replaced connection`, after.length === 0, after);
      const again = await harness.restore(executionId, {
        rerun: [
          'app',
        ],
      });
      check(`${label}: harness.restore(id, { rerun: ['app'] }) restores it`, again !== null);
      if (again === null) {
        return;
      }
      const rerun = await settle(harness.run(graph(), 'go', again));
      check(`${label}: after rerun, the run completes live`, rerun.ok, show(rerun));
      return;
    }
    check(`${label}: the resumed run completes`, out.ok, show(out));
    check(
      `${label}: the ledger is discarded from the first step that used the connection — ui.fill runs live again`,
      after.some((c) => c.op === 'ui.fill' && c.connection === 'second'),
      after,
    );
    check(
      `${label}: the once operation ui.fill keeps its original key`,
      after.some((c) => c.op === 'ui.fill' && c.key === firstKeys['ui.fill']),
      {
        firstKeys,
        after,
      },
    );
    if (replay === 'costly') {
      check(
        `${label}: the connection is reset before running live`,
        rig.resets.includes('second'),
        rig.resets,
      );
    }
    if (replay === 'free') {
      check(`${label}: no reset for a free replay`, rig.resets.length === 0, rig.resets);
    }
  } finally {
    await harness.close();
  }
}

/** `harness.restore(id, { rerun })` on a fresh harness, with no refused attempt first. */
async function unsafeRerunDirect(): Promise<void> {
  const rig: ResumeRig = {
    calls: [],
    resets: [],
    hang: true,
  };
  const storage = createInMemoryStorage();
  const executionId = await interrupt(storage, rig, resumable(rig, 'unsafe', 'first'));
  const harness = durable(storage, resumable(rig, 'unsafe', 'second'));
  try {
    const ctx = await harness.restore(executionId, {
      rerun: [
        'app',
      ],
    });
    check('unsafe, replaced, restore(rerun) first: restores', ctx !== null);
    if (ctx === null) {
      return;
    }
    const before = rig.calls.length;
    const out = await settle(harness.run(graph(), 'go', ctx));
    check('unsafe, replaced, restore(rerun) first: the run completes live', out.ok, show(out));
    check(
      'unsafe, replaced, restore(rerun) first: everything after the discarded point runs live (ui.fill too)',
      rig.calls.slice(before).some((c) => c.op === 'ui.fill'),
      rig.calls.slice(before),
    );
  } finally {
    await harness.close();
  }
}

await section('resume after an interrupted call', async () => {
  await resumeCase('free', false);
  await resumeCase('free', true);
  await resumeCase('costly', true);
  await resumeCase('unsafe', true);
  await unsafeRerunDirect();
});

//#endregion

finish('pools-triggers-resume');
process.exit();
