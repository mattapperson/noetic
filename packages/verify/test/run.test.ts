import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { Claim, VerifySpec } from '@noetic-tools/types/verify';
import { outcomeOf, VerificationRunSchema } from 'open-verification';
import { event, log, net, sense, state, ui } from '../src/matchers';
import { verifier } from '../src/verifier';
import type { FakeAct, FakeConnection } from './_helpers';
import { browserSubject, fakeConnection, fakeHost, LOG, NET, WITNESS_DB } from './_helpers';

//#region Helpers

const FAST = {
  quietMs: 30,
  timeoutMs: 400,
};

async function run(opts: {
  spec: Omit<VerifySpec, 'id'>;
  subject: FakeConnection;
  witnesses?: FakeConnection[];
  act?: FakeAct;
  signal?: AbortSignal;
}) {
  const v = verifier();
  const spec: VerifySpec = {
    id: 'checkout',
    close: FAST,
    ...opts.spec,
  };
  const participants = [
    opts.subject.participant('subject'),
    ...(opts.witnesses ?? []).map((w) => w.participant('witness')),
  ];
  const prepared = v.prepare(spec, participants);
  const host = fakeHost({
    subject: opts.subject,
    witnesses: opts.witnesses,
    act: opts.act,
    signal: opts.signal,
  });
  const output = await v.run(prepared, host);
  const [record] = host.recorded;
  assert(record);
  return {
    output,
    record,
    host,
  };
}

const ORDER_CREATED = {
  summary: 'POST /api/orders 201',
  method: 'POST',
  status: 201,
};

//#endregion

describe('verify run: declare, check before, listen, act, close, judge, record', () => {
  it('passes when the action produces independent consequence evidence', async () => {
    const app = browserSubject();
    const { output, record } = await run({
      subject: app,
      spec: {
        intent: 'Paying places an order',
        expect: [
          net('POST /api/orders 201').once().matcher,
        ],
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(output.outcome).toBe('pass');
    expect(output.verdicts).toEqual([
      {
        claim: 'expect[0]',
        verdict: 'yes',
        ground: 'proved',
        reasons: expect.any(Array),
      },
    ]);
    expect(output.run.$blob.mimeType).toBe('application/json');
    // The run is a valid OVP document whose outcome anyone can recompute.
    const parsed = VerificationRunSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    expect(outcomeOf(record)).toBe(output.outcome);
    expect(record.claims[0]?.declaredAt).toBe('before-action');
    expect(record.intents[0]).toMatchObject({
      statement: 'Paying places an order',
      status: 'bound',
    });
    expect(record.windows.map((w) => w.closedBy)).toEqual([
      'ack',
      'quiescence',
    ]);
    expect(record.receipts[0]?.dispatched).toBe(true);
  });

  it('fails when the declared consequence did not happen, and proposes a repair', async () => {
    const app = browserSubject();
    const { output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
      },
      act: () => {
        app.emit('browser.request', {
          summary: 'POST /api/orders 500',
        });
      },
    });
    expect(output.outcome).toBe('fail');
    expect(output.verdicts[0]).toMatchObject({
      verdict: 'no',
      ground: 'assertion-failed',
    });
    expect(output.repairs).toHaveLength(1);
    expect(output.repairs[0]?.actual).toContain('POST /api/orders 500');
  });

  it('a claim on an actuation-derived presence sense alone is unknown, never yes', async () => {
    const app = browserSubject();
    const { output } = await run({
      subject: app,
      spec: {
        expect: [
          ui('heading "Order confirmed"').matcher,
        ],
      },
      act: () => {
        app.emit('ui.changed', {
          summary: 'heading "Order confirmed"',
        });
      },
    });
    expect(output.verdicts[0]).toMatchObject({
      verdict: 'unknown',
      ground: 'no-independent-consequence',
    });
    expect(output.outcome).toBe('unknown');
  });

  it('a broken never fails the run even when every claim is proved', async () => {
    const app = browserSubject();
    const { output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
        never: [
          net('5xx').matcher,
        ],
      },
      act: () => {
        app.emit('browser.request', {
          summary: 'GET /api/cart 503',
        });
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(output.verdicts[0]?.verdict).toBe('yes');
    expect(output.outcome).toBe('fail');
    expect(output.violations).toHaveLength(1);
    expect(output.violations[0]).toMatchObject({
      constraint: 'never[0]',
    });
    expect(output.violations[0]?.detail).toContain('GET /api/cart 503');
  });

  it('a never with a count breaks only once the count is reached', async () => {
    const app = browserSubject();
    const { output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
        never: [
          log('error').atLeast(2).matcher,
        ],
      },
      act: () => {
        app.emit('browser.console.message', {
          summary: 'error once',
        });
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(output.violations).toHaveLength(0);
    expect(output.outcome).toBe('pass');
  });

  it('a claim that already held before the action is unknown (already-true)', async () => {
    const app = browserSubject({
      resources: {
        'browser.requests.recent': {
          sense: 'net',
          values: [
            {
              requests: [
                ORDER_CREATED,
              ],
            },
          ],
        },
      },
    });
    const { output, record } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(output.verdicts[0]).toMatchObject({
      verdict: 'unknown',
      ground: 'already-true',
    });
    expect(record.evidence.some((e) => e.observation.window === 'before')).toBe(true);
  });

  it('an event count is never judged already true from reads before the action', async () => {
    const app = browserSubject({
      senses: {
        net: WITNESS_DB,
      },
      resources: {
        'browser.requests.recent': {
          sense: 'net',
          values: [
            {
              requests: [],
            },
          ],
        },
      },
    });
    const { output } = await run({
      subject: app,
      spec: {
        expect: [
          event('browser.request').atMost(1).matcher,
        ],
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(output.verdicts[0]?.ground).not.toBe('already-true');
  });

  it('a stream gap on the claim sense keeps it from yes (buffer-truncated)', async () => {
    const app = browserSubject();
    const { output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
      },
      act: () => {
        app.gap('browser.request', 'listener overflowed');
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(output.gaps).toContainEqual(
      expect.objectContaining({
        kind: 'buffer-truncated',
        channel: 'net',
      }),
    );
    expect(output.verdicts[0]).toMatchObject({
      verdict: 'unknown',
      ground: 'coverage-impeached',
    });
  });

  it('a gap on an unrelated sense does not decide the claim', async () => {
    const app = browserSubject();
    const { output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
        never: [
          log('error').matcher,
        ],
      },
      act: () => {
        app.terminate('browser.console.message', 'console detached');
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(output.gaps).toContainEqual(
      expect.objectContaining({
        kind: 'channel-unobserved',
        channel: 'log',
      }),
    );
    expect(output.verdicts[0]?.verdict).toBe('yes');
  });

  it('a redacted value adds a redacted gap on its sense', async () => {
    const app = browserSubject();
    const { output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/login 200').matcher,
        ],
      },
      act: () => {
        app.emit('browser.request', {
          summary: 'POST /api/login 200',
          body: '<redacted>',
        });
      },
    });
    expect(output.gaps).toContainEqual(
      expect.objectContaining({
        kind: 'redacted',
        channel: 'net',
      }),
    );
    expect(output.verdicts[0]?.verdict).toBe('unknown');
  });

  it('a listener that cannot start adds a channel-unobserved gap', async () => {
    const app = browserSubject({
      listenFails: [
        'browser.request',
      ],
    });
    const { output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
      },
    });
    expect(output.gaps).toContainEqual(
      expect.objectContaining({
        kind: 'channel-unobserved',
        channel: 'net',
      }),
    );
    expect(output.verdicts[0]?.verdict).toBe('unknown');
  });

  it('a sense declared but reported by nothing adds a channel-unobserved gap', async () => {
    const app = browserSubject();
    const { output } = await run({
      subject: app,
      spec: {
        expect: [
          state('cart.total').equals(42).matcher,
        ],
      },
    });
    expect(output.gaps).toContainEqual(
      expect.objectContaining({
        kind: 'channel-unobserved',
        channel: 'state',
      }),
    );
    expect(output.verdicts[0]?.verdict).toBe('unknown');
  });

  it('a never on a sense nothing listens to adds a gap instead of passing silently', async () => {
    const app = browserSubject({
      resources: {
        'app.state': {
          sense: 'state',
          values: [
            {
              summary: 'cart.total',
              value: 1,
            },
          ],
        },
      },
    });
    const { output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
        never: [
          state('cart.total = 0').matcher,
        ],
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(output.gaps).toContainEqual(
      expect.objectContaining({
        kind: 'channel-unobserved',
        channel: 'state',
      }),
    );
    expect(output.verdicts[0]?.verdict).toBe('yes');
  });
});

describe('verify run: windows', () => {
  it('closes on a named event (signal)', async () => {
    const app = browserSubject();
    const { record, output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
        close: {
          until: 'event',
          event: 'app.done',
          timeoutMs: 2e3,
        },
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
        setTimeout(() => app.emit('app.done', {}), 20);
      },
    });
    expect(record.windows[1]?.closedBy).toBe('signal');
    expect(record.windows[1]?.closes).toBe('signal');
    expect(output.verdicts[0]?.verdict).toBe('yes');
  });

  it('a budget that runs out is never clean: unknown, window-not-closed', async () => {
    const app = browserSubject();
    const { record, output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
        close: {
          until: 'event',
          event: 'app.done',
          timeoutMs: 60,
        },
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(record.windows[1]?.closedBy).toBe('budget-exhausted');
    expect(output.verdicts[0]).toMatchObject({
      verdict: 'unknown',
      ground: 'window-not-closed',
    });
  });

  it("closes as 'ack' when act left nothing running (until: done)", async () => {
    const app = browserSubject();
    const { record } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
        close: {
          until: 'done',
        },
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(record.windows[1]?.closedBy).toBe('ack');
  });

  it('long operations still running at close add still-in-flight; unwatched effects add effect-elsewhere', async () => {
    const app = browserSubject();
    const { record, output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
        close: {
          until: 'done',
          timeoutMs: 50,
        },
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
        return {
          pendingTasks: [
            {
              connection: 'app',
              op: 'app.install',
              taskId: 't1',
            },
          ],
          touched: [
            'app',
            'mailer',
          ],
        };
      },
    });
    expect(record.windows[1]?.closedBy).toBe('budget-exhausted');
    expect(output.gaps.map((g) => g.kind)).toEqual(
      expect.arrayContaining([
        'still-in-flight',
        'effect-elsewhere',
      ]),
    );
    expect(output.gaps.find((g) => g.kind === 'effect-elsewhere')?.detail).toContain('mailer');
  });

  it("closes on the subject's own exit event (until: exit)", async () => {
    const app = fakeConnection({
      name: 'app',
      senses: {
        net: WITNESS_DB,
        'x-exit': WITNESS_DB,
      },
      events: {
        'browser.request': {
          sense: 'net',
        },
        'app.exited': {
          sense: 'x-exit',
        },
      },
    });
    const { record } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
        close: {
          until: 'exit',
          timeoutMs: 2e3,
        },
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
        setTimeout(() => app.emit('app.exited', {}), 10);
      },
    });
    expect(record.windows[1]?.closedBy).toBe('exit');
  });

  it("uses the subject's ui.settle when it offers one; an unmeasurable settle adds a non-impeaching time gap", async () => {
    const app = browserSubject({
      operations: {
        'ui.settle': {
          sense: 'time',
        },
      },
      onCall: (op) =>
        op === 'ui.settle'
          ? {
              closedBy: 'quiescence',
              unmeasurable: true,
            }
          : undefined,
    });
    const { record, output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(app.calls.map((c) => c.op)).toContain('ui.settle');
    expect(record.windows[1]?.closedBy).toBe('quiescence');
    expect(output.gaps).toContainEqual(
      expect.objectContaining({
        kind: 'channel-unobserved',
        channel: 'time',
        impeaching: false,
      }),
    );
    expect(output.verdicts[0]?.verdict).toBe('yes');
  });

  it('a subject replaced mid-window ends the window: terminated, unknown', async () => {
    const app = browserSubject();
    const { record, output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
        app.setIdentity({
          surface: 'web',
          instance: 'app-2',
        });
      },
    });
    expect(record.windows[1]?.closedBy).toBe('terminated');
    expect(record.anomalies.map((a) => a.kind)).toContain('evidence-superseded');
    expect(output.verdicts[0]?.verdict).toBe('unknown');
  });

  it('an edit (new epoch) keeps the evidence and says it predates the edit', async () => {
    const app = browserSubject({
      identity: {
        surface: 'web',
        instance: 'app-1',
        epoch: 1,
      },
    });
    const { record, output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
        app.setIdentity({
          surface: 'web',
          instance: 'app-1',
          epoch: 2,
        });
      },
    });
    expect(record.anomalies.map((a) => a.kind)).toContain('evidence-predates-edit');
    expect(output.verdicts[0]?.verdict).toBe('yes');
  });

  it('an aborted run closes as terminated', async () => {
    const app = browserSubject();
    const controller = new AbortController();
    const { record } = await run({
      subject: app,
      signal: controller.signal,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
        close: {
          until: 'event',
          event: 'app.done',
          timeoutMs: 5e3,
        },
      },
      act: () => {
        setTimeout(() => controller.abort(), 10);
      },
    });
    expect(record.windows[1]?.closedBy).toBe('terminated');
  });
});

describe('verify run: act failures, events, server reports', () => {
  it('records an act failure as evidence and an undispatched receipt', async () => {
    const app = browserSubject();
    const { record, output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
      },
      act: () => {
        throw new Error('button not found');
      },
    });
    expect(record.receipts[0]?.dispatched).toBe(false);
    expect(record.evidence.map((e) => e.observation.summary)).toContain(
      'act failed: button not found',
    );
    expect(output.verdicts[0]?.verdict).toBe('no');
  });

  it('judges event matchers by event type; signal is clamped to actuation-derived (OVP-CHAN-1)', async () => {
    const declaredIndependent = {
      senses: {
        net: WITNESS_DB,
        signal: WITNESS_DB,
      },
    };
    const app = browserSubject(declaredIndependent);
    const { output } = await run({
      subject: app,
      spec: {
        expect: [
          event('browser.signal').once().matcher,
        ],
      },
      act: () => {
        app.emit('browser.signal', {
          name: 'order.placed',
        });
      },
    });
    // The assertion held; only the sense's (clamped) independence keeps it from yes.
    expect(output.verdicts[0]).toMatchObject({
      verdict: 'unknown',
      ground: 'no-independent-consequence',
    });
    const twice = browserSubject(declaredIndependent);
    const failed = await run({
      subject: twice,
      spec: {
        expect: [
          event('browser.signal').count(2).matcher,
        ],
      },
      act: () => {
        twice.emit('browser.signal', {
          name: 'order.placed',
        });
      },
    });
    expect(failed.output.verdicts[0]?.verdict).toBe('no');
  });

  it('takes gaps from noetic://coverage and anomalies from noetic.detect', async () => {
    const app = browserSubject({
      coverage: [
        {
          kind: 'boundary-uncrossable',
          channel: 'net',
          detail: 'a service worker answered',
          impeaching: true,
        },
      ],
      anomalies: [
        {
          kind: 'failure-inside-success',
          tier: 'observed',
          claim: 'the order was created',
          counter: 'the body says error',
          between: [
            'net',
            'net',
          ],
          evidence: [],
        },
      ],
    });
    const { output, record } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(output.gaps.map((g) => g.kind)).toContain('boundary-uncrossable');
    expect(record.anomalies.map((a) => a.kind)).toContain('failure-inside-success');
    expect(output.verdicts[0]).toMatchObject({
      verdict: 'no',
      ground: 'contradicted',
    });
  });
});

describe('verify run: window boundaries', () => {
  it('asks for coverage and anomalies since the cursor listening started from', async () => {
    const app = browserSubject({
      startCursor: 'c42',
      coverage: [],
      anomalies: [],
    });
    await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(app.since).toEqual([
      'c42',
      'c42',
    ]);
  });

  it('termination from outside ends a quiet window as terminated, never clean', async () => {
    const app = browserSubject({
      events: {
        'browser.request': {
          sense: 'net',
        },
        'app.terminated': {
          sense: 'x-termination',
        },
      },
      senses: {
        net: NET,
        'x-termination': LOG,
      },
    });
    const { record, output } = await run({
      subject: app,
      spec: {
        expect: [
          net('POST /api/orders 201').matcher,
        ],
        close: {
          until: 'quiet',
          quietMs: 2e3,
          timeoutMs: 5e3,
        },
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
        app.emit('app.terminated', {});
      },
    });
    expect(record.windows[1]?.closedBy).toBe('terminated');
    expect(output.outcome).not.toBe('pass');
  });

  it('keeps a full-form OVP claim declared after the action as such', async () => {
    const app = browserSubject();
    const { record } = await run({
      subject: app,
      spec: {
        claims: [
          {
            id: 'late',
            statement: 'the order was created',
            declaredAt: 'after-action',
            assertions: [
              {
                id: 'a1',
                reads: 'the create request',
                channels: [
                  'net',
                ],
                predicate: {
                  kind: 'present',
                  match: {
                    channel: 'net',
                    summary: 'POST /api/orders 201',
                  },
                },
              },
            ],
          },
        ],
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(record.claims[0]?.declaredAt).toBe('after-action');
  });
});

describe('verify run: witnesses', () => {
  function ordersDb(values: unknown[]): FakeConnection {
    return fakeConnection({
      name: 'orders',
      senses: {
        'x-orders-db': WITNESS_DB,
      },
      resources: {
        'orders.count': {
          sense: 'x-orders-db',
          values,
        },
      },
    });
  }

  it('a witness reads until two reads agree and its independent evidence proves the claim', async () => {
    const app = browserSubject();
    const db = ordersDb([
      0,
      0,
      1,
      1,
    ]);
    const { output } = await run({
      subject: app,
      witnesses: [
        db,
      ],
      spec: {
        expect: [
          sense('x-orders-db', 'orders.count').equals(1).matcher,
        ],
      },
    });
    expect(db.reads.length).toBeGreaterThanOrEqual(3);
    expect(output.verdicts[0]?.verdict).toBe('yes');
  });

  it('a witness that never agrees with itself adds still-in-flight on its sense', async () => {
    const db = ordersDb([
      0,
      1,
      2,
      3,
      4,
      5,
      6,
    ]);
    const { output } = await run({
      subject: browserSubject(),
      witnesses: [
        db,
      ],
      spec: {
        expect: [
          sense('x-orders-db', 'orders.count').equals(1).matcher,
        ],
      },
    });
    expect(output.gaps).toContainEqual(
      expect.objectContaining({
        kind: 'still-in-flight',
        channel: 'x-orders-db',
      }),
    );
    expect(output.verdicts[0]?.verdict).toBe('unknown');
  });

  it('a witness that could not look adds a gap; it is never evidence nothing happened', async () => {
    const db = ordersDb([
      new Error('connection refused'),
    ]);
    const { output } = await run({
      subject: browserSubject(),
      witnesses: [
        db,
      ],
      spec: {
        expect: [
          sense('x-orders-db', 'orders.count').equals(1).matcher,
        ],
      },
    });
    expect(output.verdicts[0]?.verdict).toBe('unknown');
    expect(output.gaps.map((g) => g.kind)).toContain('channel-unobserved');
  });

  it("OVP's witnessDisagreement convicts a claim the subject shows but the witness cannot confirm", async () => {
    const app = browserSubject();
    const db = fakeConnection({
      name: 'orders',
      senses: {
        'x-orders-db': WITNESS_DB,
      },
      resources: {
        'orders.latest': {
          sense: 'x-orders-db',
          values: [
            {
              summary: 'orders.none',
            },
          ],
        },
      },
    });
    const claim: Claim = {
      id: 'saved',
      statement: 'the order is saved',
      declaredAt: 'before-action',
      assertions: [
        {
          id: 'a1',
          reads: 'the create request',
          channels: [
            'net',
          ],
          predicate: {
            kind: 'present',
            match: {
              channel: 'net',
              summary: 'POST /api/orders 201',
            },
          },
        },
        {
          id: 'a2',
          reads: 'the order row',
          channels: [
            'x-orders-db',
          ],
          predicate: {
            kind: 'present',
            match: {
              channel: 'x-orders-db',
              summary: 'orders.new',
            },
          },
        },
      ],
    };
    const { output, record } = await run({
      subject: app,
      witnesses: [
        db,
      ],
      spec: {
        claims: [
          claim,
        ],
      },
      act: () => {
        app.emit('browser.request', ORDER_CREATED);
      },
    });
    expect(record.verdicts[0]?.anomalies.map((a) => a.kind)).toContain('claim-uncorroborated');
    expect(output.verdicts[0]).toMatchObject({
      verdict: 'no',
      ground: 'contradicted',
    });
  });
});
