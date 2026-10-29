import { describe, expect, it } from 'bun:test';
import type { Observation } from '@noetic-tools/types/verify';
import { compileMatcher, globToRegExp, tryCompileMatcher, valuesEqual } from '../src/grammar';
import { event, log, net, route, sense, signal, state, toVerifyMatcher, ui } from '../src/matchers';
import { codeOf } from './_helpers';

function obs(channel: string, summary: string, value?: unknown): Observation {
  return {
    id: `${channel}:${summary}`,
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

describe('matcher builders', () => {
  it('builds plain sense matchers for every named sense', () => {
    expect(net('5xx').matcher).toEqual({
      kind: 'sense',
      sense: 'net',
      match: '5xx',
    });
    expect(ui('button "Pay"').matcher.sense).toBe('ui');
    expect(log('error').matcher.sense).toBe('log');
    expect(route('/done').matcher.sense).toBe('route');
    expect(state('cart.total').matcher.sense).toBe('state');
    expect(signal('order.placed').matcher.sense).toBe('signal');
    expect(sense('x-orders-db', 'orders.count').matcher.sense).toBe('x-orders-db');
  });

  it('adds count bounds without mutating the original builder', () => {
    const base = net('POST /api/orders 201');
    const once = base.once();
    expect(once.matcher.count).toBe(1);
    expect(base.matcher.count).toBeUndefined();
    expect(base.count(3).matcher.count).toBe(3);
    const bounded = base.atLeast(1).atMost(2);
    expect(bounded.matcher).toMatchObject({
      atLeast: 1,
      atMost: 2,
    });
  });

  it('records a measured value with a tolerance', () => {
    expect(
      state('cart.total').equals(42, {
        tolerance: 0.5,
      }).matcher,
    ).toMatchObject({
      equals: 42,
      tolerance: 0.5,
    });
  });

  it('builds event matchers with counts', () => {
    expect(event('device.app.crashed').atMost(0).matcher).toEqual({
      kind: 'event',
      event: 'device.app.crashed',
      atMost: 0,
    });
  });

  it('rejects an exact count combined with a bound (VERIFY_INVALID)', () => {
    expect(codeOf(() => net('5xx').once().atLeast(1))).toBe('VERIFY_INVALID');
    expect(codeOf(() => net('5xx').atMost(2).count(1))).toBe('VERIFY_INVALID');
  });

  it('rejects negative or fractional bounds (VERIFY_INVALID)', () => {
    expect(codeOf(() => net('5xx').count(-1))).toBe('VERIFY_INVALID');
    expect(codeOf(() => net('5xx').atLeast(1.5))).toBe('VERIFY_INVALID');
  });

  it('rejects a negative tolerance (VERIFY_INVALID)', () => {
    expect(
      codeOf(() =>
        state('x').equals(1, {
          tolerance: -1,
        }),
      ),
    ).toBe('VERIFY_INVALID');
  });

  it('validates plain matchers handed to toVerifyMatcher', () => {
    expect(toVerifyMatcher(net('5xx'))).toEqual(net('5xx').matcher);
    expect(
      toVerifyMatcher({
        kind: 'sense',
        sense: 'ui',
        match: 'heading',
      }),
    ).toMatchObject({
      sense: 'ui',
    });
    expect(
      codeOf(() =>
        toVerifyMatcher({
          kind: 'sense',
          sense: 'ui',
          match: 'heading',
          count: 1,
          atLeast: 1,
        }),
      ),
    ).toBe('VERIFY_INVALID');
    expect(
      codeOf(() =>
        toVerifyMatcher({
          kind: 'event',
          event: '',
        }),
      ),
    ).toBe('VERIFY_INVALID');
  });
});

describe('sense grammars', () => {
  it('net: an exact request lowers to an exact summary', () => {
    const sel = compileMatcher('net', 'POST /api/orders 201');
    expect(sel.exact).toBe('POST /api/orders 201');
    expect(sel.test(obs('net', 'POST /api/orders 201'))).toBe(true);
    expect(sel.test(obs('net', 'POST /api/orders 500'))).toBe(false);
  });

  it('net: status classes, partial matchers and path globs', () => {
    const fiveXx = compileMatcher('net', '5xx');
    expect(fiveXx.exact).toBeUndefined();
    expect(fiveXx.test(obs('net', 'GET /a 503'))).toBe(true);
    expect(fiveXx.test(obs('net', 'GET /a 404'))).toBe(false);
    const glob = compileMatcher('net', 'GET /api/*');
    expect(glob.test(obs('net', 'GET /api/orders 200'))).toBe(true);
    expect(glob.test(obs('net', 'GET /api/orders/1 200'))).toBe(false);
    expect(glob.test(obs('net', 'POST /api/orders 200'))).toBe(false);
    const deep = compileMatcher('net', '/api/**');
    expect(deep.test(obs('net', 'GET /api/orders/1 200'))).toBe(true);
    const method = compileMatcher('net', 'POST');
    expect(method.test(obs('net', 'POST /x 201'))).toBe(true);
  });

  it('net: rejects tokens out of order, repeated or unknown (VERIFY_INVALID)', () => {
    expect(codeOf(() => compileMatcher('net', '201 POST'))).toBe('VERIFY_INVALID');
    expect(codeOf(() => compileMatcher('net', 'GET POST'))).toBe('VERIFY_INVALID');
    expect(codeOf(() => compileMatcher('net', 'orders'))).toBe('VERIFY_INVALID');
    expect(codeOf(() => compileMatcher('net', 'GET /a 201 extra'))).toBe('VERIFY_INVALID');
  });

  it('ui: role with a name is exact; a role alone matches any of that role', () => {
    expect(compileMatcher('ui', 'heading "Order confirmed"').exact).toBe(
      'heading "Order confirmed"',
    );
    const any = compileMatcher('ui', 'heading');
    expect(any.test(obs('ui', 'heading "Anything"'))).toBe(true);
    expect(any.test(obs('ui', 'button "Pay"'))).toBe(false);
    expect(codeOf(() => compileMatcher('ui', 'Button Pay'))).toBe('VERIFY_INVALID');
  });

  it('log: a level, optionally with a quoted substring', () => {
    const sel = compileMatcher('log', 'error "TypeError"');
    expect(sel.test(obs('log', 'error Uncaught TypeError: x'))).toBe(true);
    expect(sel.test(obs('log', 'warn Uncaught TypeError: x'))).toBe(false);
    expect(compileMatcher('log', 'error').test(obs('log', 'error boom'))).toBe(true);
    expect(codeOf(() => compileMatcher('log', 'ERROR!'))).toBe('VERIFY_INVALID');
  });

  it('route: paths with * and ** globs', () => {
    expect(compileMatcher('route', '/checkout/done').exact).toBe('/checkout/done');
    expect(compileMatcher('route', '/checkout/*').test(obs('route', '/checkout/done'))).toBe(true);
    expect(compileMatcher('route', '/checkout/*').test(obs('route', '/checkout/a/b'))).toBe(false);
    expect(compileMatcher('route', '/checkout/**').test(obs('route', '/checkout/a/b'))).toBe(true);
    expect(codeOf(() => compileMatcher('route', 'checkout'))).toBe('VERIFY_INVALID');
  });

  it('state: a path, optionally = value', () => {
    expect(compileMatcher('state', 'cart.items').exact).toBe('cart.items');
    const eq = compileMatcher('state', 'cart.total = 42');
    expect(eq.checksValue).toBe(true);
    expect(eq.test(obs('state', 'cart.total', 42))).toBe(true);
    expect(eq.test(obs('state', 'cart.total', 41))).toBe(false);
    expect(
      compileMatcher('state', 'user.name = "Ann"').test(obs('state', 'user.name', 'Ann')),
    ).toBe(true);
    expect(compileMatcher('state', 'flag = on').test(obs('state', 'flag', 'on'))).toBe(true);
    expect(codeOf(() => compileMatcher('state', '= 4'))).toBe('VERIFY_INVALID');
  });

  it('signal, storage, time, visual and x- senses', () => {
    expect(compileMatcher('signal', 'order.placed').exact).toBe('order.placed');
    expect(compileMatcher('signal', 'order.*').test(obs('signal', 'order.placed'))).toBe(true);
    expect(compileMatcher('storage', 'local session').exact).toBe('local session');
    expect(compileMatcher('time', 'settled').exact).toBe('settled');
    expect(compileMatcher('time', 'in-flight').test(obs('time', 'in-flight upload'))).toBe(true);
    expect(compileMatcher('time', 'in-flight upload').exact).toBe('in-flight upload');
    expect(compileMatcher('visual', 'capture').exact).toBe('capture');
    expect(compileMatcher('x-orders-db', 'orders.count').exact).toBe('orders.count');
    expect(compileMatcher('x-orders-db', 'orders.*').exact).toBeUndefined();
    expect(codeOf(() => compileMatcher('signal', 'has space'))).toBe('VERIFY_INVALID');
    expect(codeOf(() => compileMatcher('storage', 'local'))).toBe('VERIFY_INVALID');
    expect(codeOf(() => compileMatcher('time', 'settled now'))).toBe('VERIFY_INVALID');
    expect(codeOf(() => compileMatcher('visual', 'pixels'))).toBe('VERIFY_INVALID');
  });

  it('rejects empty text and unknown senses', () => {
    expect(tryCompileMatcher('net', '   ')).toBeUndefined();
    expect(tryCompileMatcher('smell', 'roses')).toBeUndefined();
  });

  it('globs and value equality', () => {
    expect(globToRegExp('a.*', false).test('a.b.c')).toBe(true);
    expect(globToRegExp('/a/*', true).test('/a/b/c')).toBe(false);
    expect(valuesEqual(42.3, 42, 0.5)).toBe(true);
    expect(valuesEqual(42.6, 42, 0.5)).toBe(false);
    expect(
      valuesEqual(
        {
          a: 1,
        },
        {
          a: 1,
        },
      ),
    ).toBe(true);
  });
});
