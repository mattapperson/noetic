// `step.verify` (spec 37): builder validation, and execution through the
// harness registry and its registered verifier — act, record, the
// `noetic:verification_run` item, and every error the step can raise.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { Context, Step } from '@noetic-tools/types';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import type { VerifyOutput } from '@noetic-tools/types/verify';
import { VERIFICATION_RUN_ITEM_TYPE } from '@noetic-tools/types/verify';
import { runCode, step } from '../../src/builders/step-builders';
import type { VerifyEachOutput } from '../../src/builders/verify-builder';
import { verify } from '../../src/builders/verify-builder';
import { execute } from '../../src/interpreter/execute';
import { stepChildren } from '../../src/interpreter/step-walk';
import { createInMemoryArtifactStore } from '../../src/runtime/in-memory-artifact-store';
import {
  appConfig,
  contextOf,
  INDEPENDENT,
  scriptedVerifier,
  VerifyRegistry,
  verifyHarness,
} from './_helpers';

//#region Helpers

const NET_201 = {
  kind: 'sense',
  sense: 'net',
  match: 'POST /api/orders 201',
} as const;

function tap(id = 'pay', connection = 'app'): Step {
  return step.call({
    id,
    connection,
    op: 'ui.tap',
    args: {
      element: 'button "Pay"',
    },
  });
}

function expectConfigCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected ${code}`);
  } catch (e) {
    assert(isNoeticConfigError(e));
    expect(e.code).toBe(code);
  }
}

async function expectRejectsConfig(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected ${code}`);
  } catch (e) {
    assert(isNoeticConfigError(e));
    expect(e.code).toBe(code);
  }
}

function runItems(ctx: Context) {
  return ctx.itemLog.items.filter((i) => i.type === VERIFICATION_RUN_ITEM_TYPE);
}

//#endregion

describe('step.verify builder', () => {
  it('builds a verify step, normalizing matcher builders to plain matchers', () => {
    const built = step.verify({
      id: 'checkout',
      subject: 'app',
      expect: [
        {
          matcher: NET_201,
        },
      ],
      never: [
        {
          kind: 'sense',
          sense: 'net',
          match: '5xx',
        },
      ],
      act: tap(),
      intent: 'Paying places an order',
    });
    expect(built.kind).toBe('verify');
    expect(built.expect).toEqual([
      NET_201,
    ]);
    expect(built.never?.[0]).toMatchObject({
      match: '5xx',
    });
    expect(stepChildren(built).map((s) => s.id)).toEqual([
      'pay',
    ]);
  });

  it('EMPTY_STEP_ID without an id', () => {
    expectConfigCode(
      () =>
        verify({
          id: '',
          subject: 'app',
          expect: [],
          act: tap(),
        }),
      'EMPTY_STEP_ID',
    );
  });

  it('VERIFY_INVALID without exactly one of expect and claims', () => {
    expectConfigCode(
      () =>
        verify({
          id: 'v',
          subject: 'app',
          act: tap(),
        }),
      'VERIFY_INVALID',
    );
    expectConfigCode(
      () =>
        verify({
          id: 'v',
          subject: 'app',
          expect: [],
          claims: [],
          act: tap(),
        }),
      'VERIFY_INVALID',
    );
  });

  it('VERIFY_INVALID with both never and constraints, an empty act, or an empty subject list', () => {
    expectConfigCode(
      () =>
        verify({
          id: 'v',
          subject: 'app',
          expect: [],
          never: [],
          constraints: [],
          act: tap(),
        }),
      'VERIFY_INVALID',
    );
    expectConfigCode(
      () =>
        verify({
          id: 'v',
          subject: 'app',
          expect: [],
          act: [],
        }),
      'VERIFY_INVALID',
    );
    expectConfigCode(
      () =>
        verify({
          id: 'v',
          subject: [],
          expect: [],
          act: tap(),
        }),
      'VERIFY_INVALID',
    );
  });
});

describe('executeVerify', () => {
  it('resolves the subject and witnesses, runs act through the gates, records the run and emits the item', async () => {
    const registry = new VerifyRegistry({
      app: appConfig(),
      orders: {
        senses: {
          'x-orders-db': INDEPENDENT,
        },
        operations: {
          'db.query': {},
        },
      },
    });
    const verifier = scriptedVerifier();
    const harness = verifyHarness({
      registry,
      verifier,
    });
    const ctx = contextOf(harness);
    const output = await execute(
      step.verify({
        id: 'checkout',
        subject: 'app',
        witnesses: [
          'orders',
        ],
        expect: [
          NET_201,
        ],
        act: tap(),
        intent: 'Paying places an order',
        close: {
          quietMs: 100,
        },
      }),
      'go',
      ctx,
    );
    expect(output.outcome).toBe('pass');
    expect(output.run.$blob.uri).toMatch(/^artifact:\/\/sha256\/[0-9a-f]{64}$/);
    const [prepared] = verifier.prepared;
    assert(prepared);
    expect(prepared.spec).toMatchObject({
      id: 'checkout',
      intent: 'Paying places an order',
      expect: [
        NET_201,
      ],
      close: {
        quietMs: 100,
      },
    });
    expect(
      prepared.participants.map((p) => [
        p.name,
        p.role,
      ]),
    ).toEqual([
      [
        'app',
        'subject',
      ],
      [
        'orders',
        'witness',
      ],
    ]);
    expect(prepared.participants[1]?.senses).toEqual({
      'x-orders-db': INDEPENDENT,
    });
    expect(
      registry.calls.map((c) => [
        c.connection,
        c.op,
      ]),
    ).toEqual([
      [
        'app',
        'ui.tap',
      ],
    ]);
    const items = runItems(ctx);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      stepId: 'checkout',
      subject: 'app',
      outcome: 'pass',
      run: output.run,
    });
  });

  it("stores the run in the harness's environment.artifacts, pinned and linked to the run", async () => {
    const store = createInMemoryArtifactStore();
    const harness = verifyHarness({
      registry: new VerifyRegistry({
        app: appConfig(),
      }),
      verifier: scriptedVerifier(),
      artifacts: store,
    });
    const ctx = contextOf(harness);
    const output = await execute(
      verify({
        id: 'checkout',
        subject: 'app',
        expect: [
          NET_201,
        ],
        act: tap(),
      }),
      '',
      ctx,
    );
    const records = await store.listRun(ctx.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      uri: output.run.$blob.uri,
      source: 'verify',
      pinned: true,
    });
    const body = await store.get(output.run.$blob.uri);
    assert(body);
    const text = await new Response(body).text();
    expect(JSON.parse(text)).toMatchObject({
      ovp: '1.0',
      id: 'checkout',
    });
  });

  it('VERIFY_NOT_CONFIGURED when the harness has no verifier', async () => {
    const harness = verifyHarness({
      registry: new VerifyRegistry({
        app: appConfig(),
      }),
    });
    await expectRejectsConfig(
      execute(
        verify({
          id: 'v',
          subject: 'app',
          expect: [
            NET_201,
          ],
          act: tap(),
        }),
        '',
        contextOf(harness),
      ),
      'VERIFY_NOT_CONFIGURED',
    );
  });

  it('CONNECTION_UNKNOWN when the harness has no connections, or not the subject', async () => {
    const noRegistry = verifyHarness({
      verifier: scriptedVerifier(),
    });
    const v = verify({
      id: 'v',
      subject: 'app',
      expect: [
        NET_201,
      ],
      act: tap(),
    });
    await expectRejectsConfig(execute(v, '', contextOf(noRegistry)), 'CONNECTION_UNKNOWN');
    const otherRegistry = verifyHarness({
      verifier: scriptedVerifier(),
      registry: new VerifyRegistry({}),
    });
    await expectRejectsConfig(execute(v, '', contextOf(otherRegistry)), 'CONNECTION_UNKNOWN');
  });

  it('VERIFY_INVALID when act contains nothing that acts', async () => {
    const harness = verifyHarness({
      registry: new VerifyRegistry({
        app: appConfig(),
      }),
      verifier: scriptedVerifier(),
    });
    const readOnly = verify({
      id: 'v',
      subject: 'app',
      expect: [
        NET_201,
      ],
      act: [
        step.call({
          id: 'find',
          connection: 'app',
          op: 'ui.find',
          args: {},
        }),
        runCode({
          id: 'local',
          execute: async () => 'x',
        }),
      ],
    });
    await expectRejectsConfig(execute(readOnly, '', contextOf(harness)), 'VERIFY_INVALID');
  });

  it('VERIFY_INVALID when act asks a witness to act', async () => {
    const harness = verifyHarness({
      registry: new VerifyRegistry({
        app: appConfig(),
        orders: {
          operations: {
            'db.write': {
              effects: true,
            },
          },
        },
      }),
      verifier: scriptedVerifier(),
    });
    const v = verify({
      id: 'v',
      subject: 'app',
      witnesses: [
        'orders',
      ],
      expect: [
        NET_201,
      ],
      act: [
        tap(),
        step.call({
          id: 'write',
          connection: 'orders',
          op: 'db.write',
          args: {},
        }),
      ],
    });
    await expectRejectsConfig(execute(v, '', contextOf(harness)), 'VERIFY_INVALID');
  });

  it('VERIFY_INVALID at run time when act reaches a witness through a function target', async () => {
    const registry = new VerifyRegistry({
      app: appConfig(),
      orders: {
        operations: {
          'db.write': {
            effects: true,
          },
        },
      },
    });
    const harness = verifyHarness({
      registry,
      verifier: scriptedVerifier(),
    });
    const v = verify({
      id: 'v',
      subject: 'app',
      witnesses: [
        'orders',
      ],
      expect: [
        NET_201,
      ],
      act: [
        tap(),
        // As a hydrated JSON node is: its connection picked when it runs.
        {
          kind: 'call',
          id: 'write',
          connection: () => 'orders',
          op: 'db.write',
          args: {},
        } satisfies Step,
      ],
    });
    await expectRejectsConfig(execute(v, '', contextOf(harness)), 'VERIFY_INVALID');
    expect(registry.calls.map((c) => `${c.connection}:${c.op}`)).toEqual([
      'app:ui.tap',
    ]);
  });

  it('a witness refuses operations with effects through the host (VERIFY_INVALID)', async () => {
    let refusal: unknown;
    const verifier = scriptedVerifier({
      during: async (host) => {
        const witness = host.witnesses.orders;
        assert(witness);
        await witness.call(
          'db.query',
          {},
          {
            signal: host.signal,
          },
        );
        try {
          await witness.call(
            'db.write',
            {},
            {
              signal: host.signal,
            },
          );
        } catch (e) {
          refusal = e;
        }
      },
    });
    const registry = new VerifyRegistry({
      app: appConfig(),
      orders: {
        operations: {
          'db.query': {},
          'db.write': {
            effects: true,
          },
        },
      },
    });
    const harness = verifyHarness({
      registry,
      verifier,
    });
    await execute(
      verify({
        id: 'v',
        subject: 'app',
        witnesses: [
          'orders',
        ],
        expect: [
          NET_201,
        ],
        act: tap(),
      }),
      '',
      contextOf(harness),
    );
    assert(isNoeticConfigError(refusal));
    expect(refusal.code).toBe('VERIFY_INVALID');
    expect(registry.calls.map((c) => c.op)).toEqual([
      'ui.tap',
      'db.query',
    ]);
    expect(registry.calls[1]?.opts.caller).toBe('step');
  });

  it('verify_act_failed when act throws, after the run is recorded and the item emitted', async () => {
    const registry = new VerifyRegistry({
      app: appConfig({
        onCall: () => {
          throw new Error('button not found');
        },
      }),
    });
    const harness = verifyHarness({
      registry,
      verifier: scriptedVerifier({
        outcome: () => 'unknown',
      }),
    });
    const ctx = contextOf(harness);
    try {
      await execute(
        verify({
          id: 'checkout',
          subject: 'app',
          expect: [
            NET_201,
          ],
          act: tap(),
        }),
        '',
        ctx,
      );
      expect.unreachable('expected verify_act_failed');
    } catch (e) {
      assert(isNoeticError(e));
      assert(e.noeticError.kind === 'verify_act_failed');
      expect(e.noeticError.stepId).toBe('checkout');
      expect(e.noeticError.cause.message).toContain('button not found');
      expect(e.noeticError.run?.$blob.mimeType).toBe('application/json');
    }
    expect(runItems(ctx)).toHaveLength(1);
  });

  it('a list subject runs one verify per connection with ids <id>.<name> and the worst outcome', async () => {
    const registry = new VerifyRegistry({
      ios: appConfig(),
      android: appConfig(),
    });
    const verifier = scriptedVerifier({
      outcome: (spec) => (spec.id.endsWith('.android') ? 'fail' : 'pass'),
    });
    const harness = verifyHarness({
      registry,
      verifier,
    });
    const ctx = contextOf(harness);
    const output: VerifyEachOutput = await execute(
      step.verify({
        id: 'launch',
        subject: [
          'ios',
          'android',
        ],
        expect: [
          NET_201,
        ],
        act: (subject) => tap(`open-${subject}`, subject),
      }),
      '',
      ctx,
    );
    expect(output.outcome).toBe('fail');
    expect(Object.keys(output.subjects).sort()).toEqual([
      'android',
      'ios',
    ]);
    expect(verifier.prepared.map((p) => p.spec.id).sort()).toEqual([
      'launch.android',
      'launch.ios',
    ]);
    expect(runItems(ctx)).toHaveLength(2);
  });

  it('a list subject whose act always names one subject is VERIFY_INVALID', async () => {
    const registry = new VerifyRegistry({
      ios: appConfig(),
      android: appConfig(),
    });
    const harness = verifyHarness({
      registry,
      verifier: scriptedVerifier({}),
    });
    try {
      await execute(
        step.verify({
          id: 'launch',
          subject: [
            'ios',
            'android',
          ],
          expect: [
            NET_201,
          ],
          act: tap('open', 'ios'),
        }),
        '',
        contextOf(harness),
      );
      expect.unreachable('expected VERIFY_INVALID');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('VERIFY_INVALID');
    }
  });

  it('a list subject acts on each subject through act(subject)', async () => {
    const registry = new VerifyRegistry({
      ios: appConfig(),
      android: appConfig(),
    });
    const harness = verifyHarness({
      registry,
      verifier: scriptedVerifier(),
    });
    await execute(
      step.verify({
        id: 'launch',
        subject: [
          'ios',
          'android',
        ],
        expect: [
          NET_201,
        ],
        act: (subject) => tap(`open-${subject}`, subject),
      }),
      '',
      contextOf(harness),
    );
    expect(registry.calls.map((c) => c.connection).sort()).toEqual([
      'android',
      'ios',
    ]);
  });

  it('host connections read coverage and detect anomalies from the server, validated', async () => {
    const seen: unknown[] = [];
    const verifier = scriptedVerifier({
      during: async (host) => {
        const opts = {
          signal: host.signal,
        };
        seen.push(await host.subject.coverage?.(null, opts));
        seen.push(await host.subject.coverage?.('c9', opts));
        seen.push(await host.subject.detect?.(null, opts));
        seen.push(host.subject.identity().instance);
        seen.push(host.now() > 0);
      },
    });
    const spot = {
      kind: 'buffer-truncated',
      channel: 'net',
      detail: 'overflow',
      impeaching: true,
    };
    const anomaly = {
      kind: 'no-effect',
      tier: 'observed',
      claim: 'saved',
      counter: 'nothing changed',
      between: [
        'net',
        'net',
      ],
      evidence: [],
    };
    const registry = new VerifyRegistry({
      app: appConfig({
        resources: {
          'noetic://coverage': {
            blindSpots: [
              spot,
              {
                kind: 'not-a-kind',
              },
            ],
          },
        },
        operations: {
          'ui.tap': {
            effects: true,
          },
          'noetic.detect': {},
        },
        onCall: (op) =>
          op === 'noetic.detect'
            ? [
                anomaly,
                {
                  ...anomaly,
                  kind: 'duplicate-charge',
                },
                {
                  ...anomaly,
                  between: [
                    'net',
                    'Not A Channel',
                  ],
                },
              ]
            : null,
      }),
    });
    await execute(
      verify({
        id: 'v',
        subject: 'app',
        expect: [
          NET_201,
        ],
        act: tap(),
      }),
      '',
      contextOf(
        verifyHarness({
          registry,
          verifier,
        }),
      ),
    );
    // An entry that is not OVP is dropped; the valid ones still impeach (a lost gap would over-claim).
    expect(seen[0]).toEqual([
      spot,
    ]);
    expect(registry.reads).toContain('app:noetic://coverage?since=c9');
    expect(seen[2]).toEqual([
      anomaly,
    ]);
    expect(seen[3]).toBe('app-1');
    expect(seen[4]).toBe(true);
  });

  it('a subject without coverage or detect offers neither', async () => {
    let host: unknown;
    const verifier = scriptedVerifier({
      during: async (h) => {
        host = h.subject;
      },
    });
    await execute(
      verify({
        id: 'v',
        subject: 'app',
        expect: [
          NET_201,
        ],
        act: tap(),
      }),
      '',
      contextOf(
        verifyHarness({
          registry: new VerifyRegistry({
            app: appConfig(),
          }),
          verifier,
        }),
      ),
    );
    expect(host).not.toHaveProperty('coverage');
    expect(host).not.toHaveProperty('detect');
  });

  it('act chains step outputs and receives the verify input', async () => {
    const seen: unknown[] = [];
    const harness = verifyHarness({
      registry: new VerifyRegistry({
        app: appConfig(),
      }),
      verifier: scriptedVerifier(),
    });
    const out: VerifyOutput = await execute(
      verify({
        id: 'v',
        subject: 'app',
        expect: [
          NET_201,
        ],
        act: [
          runCode({
            id: 'first',
            execute: async (input: unknown) => {
              seen.push(input);
              return 'from-first';
            },
          }),
          step.call({
            id: 'tap',
            connection: 'app',
            op: 'ui.tap',
            args: (input: unknown) => {
              seen.push(input);
              return {};
            },
          }),
        ],
      }),
      'verify-input',
      contextOf(harness),
    );
    expect(seen).toEqual([
      'verify-input',
      'from-first',
    ]);
    expect(out.outcome).toBe('pass');
  });
});
