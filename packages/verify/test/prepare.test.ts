import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { isConnectionUnsatisfiedError } from '@noetic-tools/types';
import type { Coverage, Observation } from '@noetic-tools/types/verify';
import { event, net, state, ui } from '../src/matchers';
import { assertionsHeld, assertionsHeldUnder, evaluatePredicate } from '../src/predicates';
import { prepareVerify } from '../src/prepare';
import { browserSubject, codeOf, fakeConnection, WITNESS_DB } from './_helpers';

const NO_EVENTS = {
  eventTypeOf: () => undefined,
};

function obs(channel: string, summary: string, value?: unknown): Observation {
  return {
    id: `${channel}:${summary}:${String(value)}`,
    window: 'w',
    channel,
    at: 0,
    summary,
    ...(value === undefined
      ? {}
      : {
          value,
        }),
  };
}

function subjectOnly() {
  return [
    browserSubject().participant('subject'),
  ];
}

describe('prepareVerify lowering', () => {
  it('lowers an exact expect entry to an OVP present claim declared before the action', () => {
    const prepared = prepareVerify(
      {
        id: 'v',
        expect: [
          net('POST /api/orders 201').matcher,
        ],
      },
      subjectOnly(),
    );
    const [claim] = prepared.claims;
    expect(claim).toMatchObject({
      id: 'expect[0]',
      declaredAt: 'before-action',
    });
    expect(claim?.assertions[0]?.predicate).toEqual({
      kind: 'present',
      match: {
        channel: 'net',
        summary: 'POST /api/orders 201',
      },
    });
    expect(claim?.assertions[0]?.channels).toEqual([
      'net',
    ]);
    expect(prepared.senses.app).toEqual([
      'net',
    ]);
  });

  it('lowers counts to OVP count predicates, one per bound', () => {
    const prepared = prepareVerify(
      {
        id: 'v',
        expect: [
          net('POST /api/orders 201').once().matcher,
          ui('heading "Done"').atLeast(1).atMost(2).matcher,
        ],
      },
      subjectOnly(),
    );
    expect(prepared.claims[0]?.assertions.map((a) => a.predicate)).toEqual([
      {
        kind: 'count',
        match: {
          channel: 'net',
          summary: 'POST /api/orders 201',
        },
        op: 'exactly',
        value: 1,
      },
    ]);
    expect(prepared.claims[1]?.assertions).toHaveLength(2);
    expect(prepared.claims[0]?.statement).toContain('exactly once');
  });

  it('lowers a numeric equals to an OVP measure', () => {
    const prepared = prepareVerify(
      {
        id: 'v',
        expect: [
          state('cart.total').equals(42, {
            tolerance: 0.5,
          }).matcher,
        ],
      },
      subjectOnly(),
    );
    expect(prepared.claims[0]?.assertions[0]?.predicate).toEqual({
      kind: 'measure',
      match: {
        channel: 'state',
        summary: 'cart.total',
      },
      op: 'equals',
      value: 42,
      tolerance: 0.5,
    });
  });

  it('lowers wildcards and string values to Noetic implementation predicates', () => {
    const prepared = prepareVerify(
      {
        id: 'v',
        expect: [
          net('5xx').atMost(0).matcher,
          state('user.name').equals('Ann').matcher,
        ],
      },
      subjectOnly(),
    );
    expect(prepared.claims[0]?.assertions[0]?.predicate).toEqual({
      kind: 'x-noetic-select',
      channel: 'net',
      matcher: '5xx',
      count: {
        op: 'at-most',
        value: 0,
      },
    });
    expect(prepared.claims[1]?.assertions[0]?.predicate).toMatchObject({
      kind: 'x-noetic-select',
      equals: 'Ann',
    });
  });

  it('lowers never entries to blocking constraints: absent when exact, x-noetic-never otherwise', () => {
    const prepared = prepareVerify(
      {
        id: 'v',
        expect: [
          net('POST /a 201').matcher,
        ],
        never: [
          ui('dialog "Error"').matcher,
          net('5xx').matcher,
        ],
      },
      subjectOnly(),
    );
    expect(prepared.constraints[0]).toMatchObject({
      id: 'never[0]',
      severity: 'blocking',
      predicate: {
        kind: 'absent',
        match: {
          channel: 'ui',
          summary: 'dialog "Error"',
        },
      },
    });
    expect(prepared.constraints[1]?.predicate).toMatchObject({
      kind: 'x-noetic-never',
    });
  });

  it('lowers event matchers onto the event sense of the participant that declares it', () => {
    const subject = browserSubject({
      senses: {
        net: WITNESS_DB,
        signal: WITNESS_DB,
      },
    });
    const prepared = prepareVerify(
      {
        id: 'v',
        expect: [
          event('browser.signal').once().matcher,
        ],
        close: {
          until: 'event',
          event: 'app.done',
        },
      },
      [
        subject.participant('subject'),
      ],
    );
    expect(prepared.claims[0]?.assertions[0]?.predicate).toEqual({
      kind: 'x-noetic-event',
      channel: 'signal',
      event: 'browser.signal',
      count: {
        op: 'exactly',
        value: 1,
      },
    });
    expect(prepared.events.app).toEqual([
      'browser.signal',
      'app.done',
    ]);
  });

  it('accepts OVP claims and constraints directly', () => {
    const prepared = prepareVerify(
      {
        id: 'v',
        claims: [
          {
            id: 'c',
            statement: 'an order is created',
            declaredAt: 'after-action',
            assertions: [
              {
                id: 'a',
                reads: 'net',
                channels: [
                  'net',
                ],
              },
            ],
          },
        ],
        constraints: [
          {
            id: 'k',
            statement: 'no 5xx',
            channels: [
              'net',
            ],
            severity: 'advisory',
          },
        ],
      },
      subjectOnly(),
    );
    expect(prepared.claims[0]?.id).toBe('c');
    expect(prepared.constraints[0]?.severity).toBe('advisory');
  });
});

describe('prepareVerify validation', () => {
  const base = {
    id: 'v',
  };

  it('VERIFY_INVALID when neither or both of expect and claims are given', () => {
    expect(codeOf(() => prepareVerify(base, subjectOnly()))).toBe('VERIFY_INVALID');
    expect(
      codeOf(() =>
        prepareVerify(
          {
            ...base,
            expect: [],
            claims: [],
          },
          subjectOnly(),
        ),
      ),
    ).toBe('VERIFY_INVALID');
  });

  it('VERIFY_INVALID when both never and constraints are given', () => {
    expect(
      codeOf(() =>
        prepareVerify(
          {
            ...base,
            expect: [],
            never: [],
            constraints: [],
          },
          subjectOnly(),
        ),
      ),
    ).toBe('VERIFY_INVALID');
  });

  it('VERIFY_INVALID for a matcher its sense cannot parse', () => {
    expect(
      codeOf(() =>
        prepareVerify(
          {
            ...base,
            expect: [
              net('not a request').matcher,
            ],
          },
          subjectOnly(),
        ),
      ),
    ).toBe('VERIFY_INVALID');
  });

  it('VERIFY_INVALID for a tolerance with no value', () => {
    expect(
      codeOf(() =>
        prepareVerify(
          {
            ...base,
            expect: [
              {
                kind: 'sense',
                sense: 'state',
                match: 'x',
                tolerance: 1,
              },
            ],
          },
          subjectOnly(),
        ),
      ),
    ).toBe('VERIFY_INVALID');
  });

  it('VERIFY_INVALID for a malformed OVP claim or constraint', () => {
    expect(
      codeOf(() =>
        prepareVerify(
          {
            ...base,
            claims: [
              {
                id: '',
                statement: 's',
                declaredAt: 'before-action',
                assertions: [],
              },
            ],
          },
          subjectOnly(),
        ),
      ),
    ).toBe('VERIFY_INVALID');
    expect(
      codeOf(() =>
        prepareVerify(
          {
            ...base,
            expect: [],
            constraints: [
              {
                id: 'k',
                statement: 's',
                channels: [],
                severity: 'blocking',
              },
            ],
          },
          subjectOnly(),
        ),
      ),
    ).toBe('VERIFY_INVALID');
  });

  it('VERIFY_INVALID for close.until event without an event, or a non-positive budget', () => {
    expect(
      codeOf(() =>
        prepareVerify(
          {
            ...base,
            expect: [],
            close: {
              until: 'event',
            },
          },
          subjectOnly(),
        ),
      ),
    ).toBe('VERIFY_INVALID');
    expect(
      codeOf(() =>
        prepareVerify(
          {
            ...base,
            expect: [],
            close: {
              timeoutMs: 0,
            },
          },
          subjectOnly(),
        ),
      ),
    ).toBe('VERIFY_INVALID');
  });

  it('VERIFY_INVALID without a subject', () => {
    expect(
      codeOf(() =>
        prepareVerify(
          {
            ...base,
            expect: [],
          },
          [],
        ),
      ),
    ).toBe('VERIFY_INVALID');
  });

  it('CONNECTION_UNSATISFIED for a sense no participant perceives, naming the sense', () => {
    let caught: unknown;
    try {
      prepareVerify(
        {
          ...base,
          expect: [
            {
              kind: 'sense',
              sense: 'storage',
              match: 'local session',
            },
          ],
        },
        subjectOnly(),
      );
    } catch (error) {
      caught = error;
    }
    assert(isConnectionUnsatisfiedError(caught));
    expect(caught.code).toBe('CONNECTION_UNSATISFIED');
    expect(caught.missing).toEqual({
      kind: 'sense',
      sense: 'storage',
    });
  });

  it('a witness can perceive a sense the subject cannot', () => {
    const witness = fakeConnection({
      name: 'db',
      senses: {
        'x-orders-db': WITNESS_DB,
      },
    });
    const prepared = prepareVerify(
      {
        ...base,
        expect: [
          {
            kind: 'sense',
            sense: 'x-orders-db',
            match: 'orders.count',
          },
        ],
      },
      [
        browserSubject().participant('subject'),
        witness.participant('witness'),
      ],
    );
    expect(prepared.senses.db).toEqual([
      'x-orders-db',
    ]);
    expect(prepared.senses.app).toEqual([]);
  });

  it('CONNECTION_UNSATISFIED for an event no participant offers, and for a close event', () => {
    expect(
      codeOf(() =>
        prepareVerify(
          {
            ...base,
            expect: [
              event('nope').matcher,
            ],
          },
          subjectOnly(),
        ),
      ),
    ).toBe('CONNECTION_UNSATISFIED');
    expect(
      codeOf(() =>
        prepareVerify(
          {
            ...base,
            expect: [],
            close: {
              until: 'event',
              event: 'nope',
            },
          },
          subjectOnly(),
        ),
      ),
    ).toBe('CONNECTION_UNSATISFIED');
  });

  it('CONNECTION_UNSATISFIED when an event names a sense its connection does not declare', () => {
    expect(
      codeOf(() =>
        prepareVerify(
          {
            ...base,
            expect: [
              event('browser.signal').matcher,
            ],
          },
          subjectOnly(),
        ),
      ),
    ).toBe('CONNECTION_UNSATISFIED');
  });

  it('VERIFY_INVALID for an OVP claim channel that is not a sense', () => {
    expect(
      codeOf(() =>
        prepareVerify(
          {
            ...base,
            claims: [
              {
                id: 'c',
                statement: 's',
                declaredAt: 'before-action',
                assertions: [
                  {
                    id: 'a',
                    reads: 'r',
                    channels: [
                      'x-unknown',
                    ],
                  },
                ],
              },
            ],
          },
          subjectOnly(),
        ),
      ),
    ).toBe('CONNECTION_UNSATISFIED');
  });
});

describe('predicates', () => {
  const count = (op: 'exactly' | 'at-least' | 'at-most', value: number) => ({
    kind: 'x-noetic-select',
    channel: 'net',
    matcher: '5xx',
    count: {
      op,
      value,
    },
  });
  const twoErrors = [
    obs('net', 'GET /a 500'),
    obs('net', 'GET /b 503'),
    obs('net', 'GET /c 200'),
  ];

  it('count bounds at N-1, N and N+1', () => {
    expect(evaluatePredicate(count('exactly', 1), twoErrors, NO_EVENTS)).toBe(false);
    expect(evaluatePredicate(count('exactly', 2), twoErrors, NO_EVENTS)).toBe(true);
    expect(evaluatePredicate(count('exactly', 3), twoErrors, NO_EVENTS)).toBe(false);
    expect(evaluatePredicate(count('at-least', 1), twoErrors, NO_EVENTS)).toBe(true);
    expect(evaluatePredicate(count('at-least', 2), twoErrors, NO_EVENTS)).toBe(true);
    expect(evaluatePredicate(count('at-least', 3), twoErrors, NO_EVENTS)).toBe(false);
    expect(evaluatePredicate(count('at-most', 1), twoErrors, NO_EVENTS)).toBe(false);
    expect(evaluatePredicate(count('at-most', 2), twoErrors, NO_EVENTS)).toBe(true);
    expect(evaluatePredicate(count('at-most', 3), twoErrors, NO_EVENTS)).toBe(true);
  });

  it('OVP predicates go to OVP evaluate; unknown predicates are undefined, never false', () => {
    expect(
      evaluatePredicate(
        {
          kind: 'present',
          match: {
            channel: 'net',
            summary: 'GET /c 200',
          },
        },
        twoErrors,
        NO_EVENTS,
      ),
    ).toBe(true);
    expect(
      evaluatePredicate(
        {
          kind: 'mystery',
        },
        twoErrors,
        NO_EVENTS,
      ),
    ).toBeUndefined();
    expect(evaluatePredicate(undefined, twoErrors, NO_EVENTS)).toBeUndefined();
  });

  it('select with a value is undefined when nothing carries a value', () => {
    const p = {
      kind: 'x-noetic-select',
      channel: 'state',
      matcher: 'user.name',
      equals: 'Ann',
    };
    expect(
      evaluatePredicate(
        p,
        [
          obs('state', 'user.name'),
        ],
        NO_EVENTS,
      ),
    ).toBeUndefined();
    expect(
      evaluatePredicate(
        p,
        [
          obs('state', 'user.name', 'Ann'),
        ],
        NO_EVENTS,
      ),
    ).toBe(true);
    expect(
      evaluatePredicate(
        p,
        [
          obs('state', 'user.name', 'Bob'),
        ],
        NO_EVENTS,
      ),
    ).toBe(false);
  });

  it('a select whose matcher no longer parses is undefined', () => {
    expect(
      evaluatePredicate(
        {
          kind: 'x-noetic-select',
          channel: 'net',
          matcher: '???',
        },
        twoErrors,
        NO_EVENTS,
      ),
    ).toBeUndefined();
  });

  it('event predicates match by event type', () => {
    const o = obs('signal', 'x');
    const ctx = {
      eventTypeOf: (x: Observation) => (x.id === o.id ? 'device.app.crashed' : undefined),
    };
    expect(
      evaluatePredicate(
        {
          kind: 'x-noetic-event',
          channel: 'signal',
          event: 'device.app.crashed',
        },
        [
          o,
        ],
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluatePredicate(
        {
          kind: 'x-noetic-event',
          channel: 'signal',
          event: 'device.*',
          count: {
            op: 'exactly',
            value: 2,
          },
        },
        [
          o,
        ],
        ctx,
      ),
    ).toBe(false);
  });

  it('never predicates hold until everything they forbid holds, three-valued', () => {
    const never = (holds: unknown[]) => ({
      kind: 'x-noetic-never',
      holds,
    });
    expect(
      evaluatePredicate(
        never([
          count('at-least', 1),
        ]),
        twoErrors,
        NO_EVENTS,
      ),
    ).toBe(false);
    expect(
      evaluatePredicate(
        never([
          count('at-least', 3),
        ]),
        twoErrors,
        NO_EVENTS,
      ),
    ).toBe(true);
    expect(
      evaluatePredicate(
        never([
          {
            kind: 'mystery',
          },
        ]),
        twoErrors,
        NO_EVENTS,
      ),
    ).toBeUndefined();
  });

  it('assertionsHeld is three-valued; a gap on a sense read makes it undefined', () => {
    const held = [
      {
        predicate: count('at-least', 1),
        channels: [
          'net',
        ],
      },
    ];
    expect(assertionsHeld(held, twoErrors, NO_EVENTS)).toBe(true);
    expect(
      assertionsHeld(
        [
          {
            predicate: undefined,
          },
        ],
        twoErrors,
        NO_EVENTS,
      ),
    ).toBeUndefined();
    const blind: Coverage = {
      window: 'w',
      observed: [],
      blindSpots: [
        {
          kind: 'buffer-truncated',
          channel: 'net',
          detail: 'overflow',
          impeaching: false,
        },
      ],
    };
    expect(
      assertionsHeldUnder({
        assertions: held,
        observations: twoErrors,
        coverage: blind,
        ctx: NO_EVENTS,
      }),
    ).toBeUndefined();
    expect(
      assertionsHeldUnder({
        assertions: held,
        observations: twoErrors,
        coverage: {
          ...blind,
          blindSpots: [],
        },
        ctx: NO_EVENTS,
      }),
    ).toBe(true);
  });
});
