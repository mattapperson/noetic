// The JSON `verify` node (spec 37 § In JSON): hydration of matchers, subject,
// witnesses and act, list subjects, and the errors hydration raises.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData, Step, WorkflowNode } from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError } from '@noetic-tools/types';
import { VERIFICATION_RUN_ITEM_TYPE } from '@noetic-tools/types/verify';
import type { VerifyEachOutput } from '../../src/builders/verify-builder';
import type { HydrationContext } from '../../src/builders/workflow-hydrator';
import { hydrateNode } from '../../src/builders/workflow-hydrator';
import { hydrateVerifyNode } from '../../src/builders/workflow-verify';
import { execute } from '../../src/interpreter/execute';
import { isStepList } from '../../src/interpreter/step-walk';
import { appConfig, contextOf, scriptedVerifier, VerifyRegistry, verifyHarness } from './_helpers';

//#region Helpers

function hydration(extra?: Partial<HydrationContext>): HydrationContext {
  return {
    tools: new Map(),
    executeStep: (s, i, c) => execute(s, i, c),
    ...extra,
  };
}

function verifyNode(extra?: Record<string, unknown>): WorkflowNode {
  return {
    kind: 'verify',
    id: 'checkout',
    subject: 'app',
    expect: [
      {
        net: 'POST /api/orders 201',
        count: 1,
      },
      {
        ui: 'heading "Order confirmed"',
      },
    ],
    never: [
      {
        net: '5xx',
      },
    ],
    act: [
      {
        'ui.tap': {
          element: 'button "Pay"',
        },
      },
    ],
    ...extra,
  } satisfies WorkflowNode;
}

function actOf(
  s: Step<ContextData, string, string>,
): ReadonlyArray<Step<ContextData, string, unknown>> {
  assert(s.kind === 'verify');
  // A hydrated JSON verify's act is built per subject at hydration, never a function.
  assert(typeof s.act !== 'function');
  return isStepList(s.act)
    ? s.act
    : [
        s.act,
      ];
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

//#endregion

describe('hydrateVerifyNode', () => {
  it('turns JSON matchers into plain matchers and act shorthand into calls on the subject', () => {
    const hydrated = hydrateVerifyNode(verifyNode(), hydration());
    assert(hydrated.kind === 'verify');
    expect(hydrated.subject).toBe('app');
    expect(hydrated.expect).toEqual([
      {
        kind: 'sense',
        sense: 'net',
        match: 'POST /api/orders 201',
        count: 1,
      },
      {
        kind: 'sense',
        sense: 'ui',
        match: 'heading "Order confirmed"',
      },
    ]);
    expect(hydrated.never?.[0]).toMatchObject({
      match: '5xx',
    });
    const [tap] = actOf(hydrated);
    assert(tap?.kind === 'call');
    expect(tap.id).toBe('checkout[0]');
    expect(tap.connection).toBe('app');
    expect(tap.op).toBe('ui.tap');
  });

  it('a call node in act without a connection runs on the subject; one that names another keeps it', () => {
    const hydrated = hydrateVerifyNode(
      verifyNode({
        act: [
          {
            kind: 'call',
            id: 'tap',
            op: 'ui.tap',
          },
          {
            kind: 'call',
            id: 'mail',
            connection: 'mailer',
            op: 'mail.send',
          },
        ],
      }),
      hydration(),
    );
    const [tap, mail] = actOf(hydrated);
    assert(tap?.kind === 'call' && mail?.kind === 'call');
    expect(tap.connection).toBe('app');
    expect(mail.connection).toBe('mailer');
  });

  it('binds subject and witnesses to the document manifest, and carries OVP claims, close and intent', () => {
    const claims = [
      {
        id: 'c',
        statement: 'saved',
        declaredAt: 'before-action' as const,
        assertions: [],
      },
    ];
    const hydrated = hydrateVerifyNode(
      verifyNode({
        expect: undefined,
        never: undefined,
        claims,
        constraints: [],
        witnesses: [
          'orders',
        ],
        close: {
          until: 'event',
          event: 'app.done',
        },
        intent: 'Paying places an order',
      }),
      hydration({
        connections: {
          app: {
            profile: 'browser@^1',
          },
          orders: {
            extensions: {
              'tools.noetic.db': '^1',
            },
          },
        },
      }),
    );
    assert(hydrated.kind === 'verify');
    expect(hydrated.subject).toMatchObject({
      kind: 'connection-handle',
      name: 'app',
    });
    expect(hydrated.witnesses?.[0]).toMatchObject({
      kind: 'connection-handle',
      name: 'orders',
    });
    expect(hydrated.claims).toEqual(claims);
    expect(hydrated.close).toEqual({
      until: 'event',
      event: 'app.done',
    });
    expect(hydrated.intent).toBe('Paying places an order');
  });

  it('CONNECTION_UNKNOWN for a subject or witness the manifest does not declare', () => {
    const connections = {
      app: {
        profile: 'browser@^1',
      },
    };
    expectConfigCode(
      () =>
        hydrateVerifyNode(
          verifyNode({
            subject: 'nope',
          }),
          hydration({
            connections,
          }),
        ),
      'CONNECTION_UNKNOWN',
    );
    expectConfigCode(
      () =>
        hydrateVerifyNode(
          verifyNode({
            witnesses: [
              'nope',
            ],
          }),
          hydration({
            connections,
          }),
        ),
      'CONNECTION_UNKNOWN',
    );
  });

  it('VERIFY_INVALID for a matcher that names no sense or event', () => {
    expectConfigCode(
      () =>
        hydrateVerifyNode(
          verifyNode({
            expect: [
              {
                count: 1,
              },
            ],
          }),
          hydration(),
        ),
      'VERIFY_INVALID',
    );
    expectConfigCode(
      () =>
        hydrateVerifyNode(
          verifyNode({
            never: [
              {
                smell: 'roses',
              },
            ],
          }),
          hydration(),
        ),
      'VERIFY_INVALID',
    );
  });

  it('an expression subject is evaluated per run against the input', async () => {
    const hydrated = hydrateVerifyNode(
      verifyNode({
        subject: {
          $expr: 'target',
        },
      }),
      hydration(),
    );
    assert(hydrated.kind === 'verify');
    const subject = hydrated.subject;
    assert(typeof subject === 'function');
    const ctx = contextOf(verifyHarness({}));
    expect(
      await subject(
        JSON.stringify({
          target: 'app',
        }),
        ctx,
      ),
    ).toBe('app');
    try {
      await subject(
        JSON.stringify({
          target: 4,
        }),
        ctx,
      );
      expect.unreachable('expected CONNECTION_INVALID');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('CONNECTION_INVALID');
    }
  });

  it('is the hydrator for verify nodes, and ignores other kinds', () => {
    expect(hydrateNode(verifyNode(), hydration()).kind).toBe('verify');
    expect(
      hydrateVerifyNode(
        {
          kind: 'compute',
          id: 'x',
          expr: '1',
        },
        hydration(),
      ),
    ).toBeUndefined();
  });

  it('a list subject runs one verify per connection, each acting on its own subject', async () => {
    const registry = new VerifyRegistry({
      ios: appConfig(),
      android: appConfig(),
    });
    const verifier = scriptedVerifier({
      outcome: (spec) => (spec.id === 'checkout.ios' ? 'partial' : 'pass'),
    });
    const harness = verifyHarness({
      registry,
      verifier,
    });
    const ctx = contextOf(harness);
    const hydrated = hydrateVerifyNode(
      verifyNode({
        subject: [
          'ios',
          'android',
        ],
      }),
      hydration(),
    );
    expect(hydrated.id).toBe('checkout');
    const output = frameworkCast<VerifyEachOutput>(await execute(hydrated, '{}', ctx));
    expect(output.outcome).toBe('partial');
    expect(Object.keys(output.subjects).sort()).toEqual([
      'android',
      'ios',
    ]);
    expect(registry.calls.map((c) => `${c.connection}:${c.op}`).sort()).toEqual([
      'android:ui.tap',
      'ios:ui.tap',
    ]);
    expect(ctx.itemLog.items.filter((i) => i.type === VERIFICATION_RUN_ITEM_TYPE)).toHaveLength(2);
  });
});
