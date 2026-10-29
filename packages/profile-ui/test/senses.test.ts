import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { SenseMatcher, SenseMatcherParse } from '../src/index';
import {
  exactSummaryGrammar,
  formatLogSummary,
  formatNetSummary,
  formatRouteSummary,
  formatSignalSummary,
  formatStateSummary,
  formatStorageSummary,
  formatTimeSummary,
  formatUiSummary,
  globToRegExp,
  hasGlob,
  isSignalName,
  isStatePath,
  matchesGlob,
  parseLocator,
  parseLogSummary,
  parseNetSummary,
  parseSenseMatcher,
  parseStorageSummary,
  quote,
  quoteIfNeeded,
  senseGrammarFor,
  senseGrammars,
  tokenize,
  VISUAL_SUMMARY,
} from '../src/index';

function matcher(sense: string, text: string): SenseMatcher {
  const result = parseSenseMatcher(sense, text);
  assert(result.ok, `expected '${text}' to parse as ${sense}`);
  return result.matcher;
}

function reasonOf(result: SenseMatcherParse): string {
  assert(!result.ok, 'expected a malformed matcher');
  return result.reason;
}

interface HitCase<V> {
  readonly value?: V;
}

function hits<V = never>(
  sense: string,
  text: string,
  summary: string,
  extra: HitCase<V> = {},
): boolean {
  return matcher(sense, text).matches({
    summary,
    value: extra.value,
  });
}

describe('tokenize', () => {
  it('reads words and quoted strings with escapes', () => {
    const read = tokenize('button "Say \\"hi\\" \\\\ now"  x');
    assert(read.ok);
    expect(read.tokens).toEqual([
      {
        kind: 'word',
        value: 'button',
      },
      {
        kind: 'quoted',
        value: 'Say "hi" \\ now',
      },
      {
        kind: 'word',
        value: 'x',
      },
    ]);
  });

  it('refuses unterminated quotes, unknown escapes and glued quotes', () => {
    expect(tokenize('"open').ok).toBe(false);
    expect(tokenize('"a\\n"').ok).toBe(false);
    expect(tokenize('"a"b').ok).toBe(false);
    expect(tokenize('a"b"').ok).toBe(false);
    expect(tokenize('"a\\').ok).toBe(false);
  });

  it('quotes round-trip', () => {
    const read = tokenize(quote('a "b" \\ c'));
    assert(read.ok);
    expect(read.tokens[0]?.value).toBe('a "b" \\ c');
    expect(quoteIfNeeded('session')).toBe('session');
    expect(quoteIfNeeded('my key')).toBe('"my key"');
    expect(quoteIfNeeded('')).toBe('""');
  });
});

describe('globs', () => {
  it('* stays in a segment, ** crosses segments, trailing /** matches the prefix', () => {
    expect(matchesGlob('/api/*', '/api/orders')).toBe(true);
    expect(matchesGlob('/api/*', '/api/orders/1')).toBe(false);
    expect(matchesGlob('/api/**', '/api/orders/1')).toBe(true);
    expect(matchesGlob('/api/**', '/api')).toBe(true);
    expect(matchesGlob('/a/**/z', '/a/b/c/z')).toBe(true);
    expect(matchesGlob('/a.b', '/aXb')).toBe(false);
    expect(hasGlob('/a/*')).toBe(true);
    expect(hasGlob('/a')).toBe(false);
    expect(globToRegExp('/x').test('/x')).toBe(true);
  });
});

describe('ui sense', () => {
  it('formats role "name" and the bare role', () => {
    expect(
      formatUiSummary({
        role: 'button',
        name: 'Pay',
      }),
    ).toBe('button "Pay"');
    expect(
      formatUiSummary({
        role: 'heading',
        name: 'Say "hi"',
      }),
    ).toBe('heading "Say \\"hi\\""');
    expect(
      formatUiSummary({
        role: 'main',
      }),
    ).toBe('main');
    expect(
      formatUiSummary({
        role: 'main',
        name: '',
      }),
    ).toBe('main');
  });

  it('a role and name lowers to the exact summary', () => {
    const m = matcher('ui', 'button "Pay"');
    expect(m.summary).toBe('button "Pay"');
    expect(
      m.matches({
        summary: 'button "Pay"',
      }),
    ).toBe(true);
    expect(
      m.matches({
        summary: 'button "Pay now"',
      }),
    ).toBe(false);
    expect(
      m.matches({
        summary: 'link "Pay"',
      }),
    ).toBe(false);
  });

  it('a bare role is a predicate matching any name', () => {
    const m = matcher('ui', 'heading');
    expect(m.summary).toBeUndefined();
    expect(
      m.matches({
        summary: 'heading "Order confirmed"',
      }),
    ).toBe(true);
    expect(
      m.matches({
        summary: 'heading',
      }),
    ).toBe(true);
    expect(
      m.matches({
        summary: 'not a "summary',
      }),
    ).toBe(false);
  });

  it('refuses malformed locators', () => {
    expect(reasonOf(parseSenseMatcher('ui', ''))).toContain('role');
    expect(reasonOf(parseSenseMatcher('ui', 'Button "Pay"'))).toContain('not a role');
    expect(reasonOf(parseSenseMatcher('ui', '"Pay"'))).toContain('not a role');
    expect(reasonOf(parseSenseMatcher('ui', 'button Pay'))).toContain('quoted');
    expect(reasonOf(parseSenseMatcher('ui', 'button "Pay" "x"'))).toContain('at most one');
    expect(reasonOf(parseSenseMatcher('ui', 'button "Pay'))).toContain('Unterminated');
    expect(parseLocator('button "Pay"')).toEqual({
      role: 'button',
      name: 'Pay',
    });
  });
});

describe('net sense', () => {
  it('formats METHOD /path STATUS, dropping the query and keeping cross-origin origins', () => {
    expect(
      formatNetSummary({
        method: 'post',
        url: '/api/orders?x=1#f',
        status: 201,
      }),
    ).toBe('POST /api/orders 201');
    expect(
      formatNetSummary({
        method: 'GET',
        url: 'http://localhost:5173/api/cart?id=2',
        status: 200,
        origin: 'http://localhost:5173',
      }),
    ).toBe('GET /api/cart 200');
    expect(
      formatNetSummary({
        method: 'POST',
        url: 'https://api.stripe.com/v1/charges?k=v',
        status: 402,
        origin: 'http://localhost:5173',
      }),
    ).toBe('POST https://api.stripe.com/v1/charges 402');
    expect(
      formatNetSummary({
        method: 'GET',
        url: 'https://cdn.example.com/a.js',
      }),
    ).toBe('GET https://cdn.example.com/a.js');
    expect(
      formatNetSummary({
        method: 'GET',
        url: '/pending',
        status: null,
      }),
    ).toBe('GET /pending');
  });

  it('reads summaries back', () => {
    expect(parseNetSummary('POST /api/orders 201')).toEqual({
      method: 'POST',
      target: '/api/orders',
      status: 201,
    });
    expect(parseNetSummary('GET /x')).toEqual({
      method: 'GET',
      target: '/x',
      status: undefined,
    });
    expect(parseNetSummary('get /x')).toBeUndefined();
    expect(parseNetSummary('GET')).toBeUndefined();
    expect(parseNetSummary('GET /x 2000')).toBeUndefined();
    expect(parseNetSummary('GET /x 200 extra')).toBeUndefined();
  });

  it('a full matcher lowers to the exact summary', () => {
    const m = matcher('net', 'POST /api/orders 201');
    expect(m.summary).toBe('POST /api/orders 201');
    expect(hits('net', 'POST /api/orders 201', 'POST /api/orders 201')).toBe(true);
    expect(hits('net', 'POST /api/orders 201', 'POST /api/orders 200')).toBe(false);
    expect(hits('net', 'POST /api/orders 201', 'GET /api/orders 201')).toBe(false);
  });

  it('partial matchers, globs and status classes are predicates', () => {
    expect(matcher('net', 'GET /api/*').summary).toBeUndefined();
    expect(matcher('net', '5xx').summary).toBeUndefined();
    expect(matcher('net', 'POST /api/orders').summary).toBeUndefined();
    expect(matcher('net', 'POST /api/* 201').summary).toBeUndefined();
    expect(hits('net', 'GET /api/*', 'GET /api/cart 200')).toBe(true);
    expect(hits('net', 'GET /api/*', 'GET /api/cart/1 200')).toBe(false);
    expect(hits('net', 'GET /api/**', 'GET /api/cart/1 200')).toBe(true);
    expect(hits('net', '5xx', 'POST /api/orders 503')).toBe(true);
    expect(hits('net', '5XX', 'POST /api/orders 503')).toBe(true);
    expect(hits('net', '5xx', 'POST /api/orders 499')).toBe(false);
    expect(hits('net', '5xx', 'POST /api/orders')).toBe(false);
    expect(hits('net', 'POST', 'POST /x 200')).toBe(true);
    expect(hits('net', '/api/orders', 'https://other.com/api/orders 200')).toBe(false);
    expect(hits('net', 'https://other.com/api/*', 'GET https://other.com/api/orders 200')).toBe(
      true,
    );
    expect(hits('net', 'POST /api/orders 201', 'garbage')).toBe(false);
  });

  it('refuses malformed net matchers', () => {
    expect(reasonOf(parseSenseMatcher('net', ''))).toContain('needs a method');
    expect(reasonOf(parseSenseMatcher('net', 'post /x'))).toContain('not a method');
    expect(reasonOf(parseSenseMatcher('net', '/x POST'))).toContain('in that order');
    expect(reasonOf(parseSenseMatcher('net', 'GET GET'))).toContain('in that order');
    expect(reasonOf(parseSenseMatcher('net', '201 /x'))).toContain('in that order');
    expect(reasonOf(parseSenseMatcher('net', 'GET /x?y=1'))).toContain('query');
    expect(reasonOf(parseSenseMatcher('net', 'GET /x 600'))).toContain('not a method');
    expect(reasonOf(parseSenseMatcher('net', 'GET "/x"'))).toContain('not a method');
    expect(reasonOf(parseSenseMatcher('net', 'GET "/x'))).toContain('Unterminated');
  });
});

describe('log sense', () => {
  it('formats level message on one line', () => {
    expect(
      formatLogSummary({
        level: 'ERROR',
        message: 'Uncaught TypeError:\n  x is undefined',
      }),
    ).toBe('error Uncaught TypeError: x is undefined');
    expect(
      formatLogSummary({
        level: 'info',
        message: '  ',
      }),
    ).toBe('info');
    expect(parseLogSummary('warn deprecated')).toEqual({
      level: 'warn',
      message: 'deprecated',
    });
    expect(parseLogSummary('info')).toEqual({
      level: 'info',
      message: '',
    });
    expect(parseLogSummary('ERROR x')).toBeUndefined();
  });

  it('matches a level, optionally with a substring', () => {
    expect(matcher('log', 'error').summary).toBeUndefined();
    expect(hits('log', 'error', 'error Uncaught TypeError: x')).toBe(true);
    expect(hits('log', 'error', 'warn Uncaught TypeError: x')).toBe(false);
    expect(hits('log', 'error "TypeError"', 'error Uncaught TypeError: x')).toBe(true);
    expect(hits('log', 'error "RangeError"', 'error Uncaught TypeError: x')).toBe(false);
    expect(hits('log', 'error', 'Not A Level')).toBe(false);
  });

  it('refuses malformed log matchers', () => {
    expect(reasonOf(parseSenseMatcher('log', ''))).toContain('level');
    expect(reasonOf(parseSenseMatcher('log', 'Error'))).toContain('level');
    expect(reasonOf(parseSenseMatcher('log', '"TypeError"'))).toContain('level');
    expect(reasonOf(parseSenseMatcher('log', 'error TypeError'))).toContain('quoted');
    expect(reasonOf(parseSenseMatcher('log', 'error "a" "b"'))).toContain('at most one');
    expect(reasonOf(parseSenseMatcher('log', 'error "a'))).toContain('Unterminated');
  });
});

describe('route sense', () => {
  it('formats the path of a URL or path', () => {
    expect(formatRouteSummary('http://localhost:5173/checkout/done?x=1#y')).toBe('/checkout/done');
    expect(formatRouteSummary('/cart?step=2')).toBe('/cart');
  });

  it('matches paths and globs', () => {
    expect(matcher('route', '/checkout/done').summary).toBe('/checkout/done');
    expect(matcher('route', '/checkout/*').summary).toBeUndefined();
    expect(hits('route', '/checkout/done', '/checkout/done')).toBe(true);
    expect(hits('route', '/checkout/done', '/checkout')).toBe(false);
    expect(hits('route', '/checkout/*', '/checkout/done')).toBe(true);
    expect(hits('route', '/checkout/**', '/checkout')).toBe(true);
    expect(hits('route', '/checkout/**', '/checkout/a/b')).toBe(true);
    expect(hits('route', ' /a ', '/a')).toBe(true);
  });

  it('refuses malformed routes', () => {
    expect(reasonOf(parseSenseMatcher('route', 'checkout'))).toContain('not a route');
    expect(reasonOf(parseSenseMatcher('route', ''))).toContain('not a route');
    expect(reasonOf(parseSenseMatcher('route', '/a?b=1'))).toContain('not a route');
    expect(reasonOf(parseSenseMatcher('route', '/a b'))).toContain('not a route');
    expect(reasonOf(parseSenseMatcher('route', '/a#x'))).toContain('not a route');
  });
});

describe('state sense', () => {
  it('formats the path', () => {
    expect(formatStateSummary(' cart.items ')).toBe('cart.items');
    expect(isStatePath('orders.0.id')).toBe(true);
    expect(isStatePath('a..b')).toBe(false);
  });

  it('a path matches the path; = value also compares the value', () => {
    const plain = matcher('state', 'cart.total');
    expect(plain.summary).toBe('cart.total');
    expect(plain.equals).toBeUndefined();
    expect(
      hits('state', 'cart.total', 'cart.total', {
        value: 1,
      }),
    ).toBe(true);
    expect(
      hits('state', 'cart.total', 'cart.items', {
        value: 1,
      }),
    ).toBe(false);

    const valued = matcher('state', 'cart.total = 42');
    expect(valued.summary).toBe('cart.total');
    expect(valued.equals).toBe(42);
    expect(
      hits('state', 'cart.total = 42', 'cart.total', {
        value: 42,
      }),
    ).toBe(true);
    expect(
      hits('state', 'cart.total=42', 'cart.total', {
        value: 41,
      }),
    ).toBe(false);
    expect(
      hits('state', 'user.role = "admin"', 'user.role', {
        value: 'admin',
      }),
    ).toBe(true);
    expect(
      hits('state', 'flags = [1, {"a": true}]', 'flags', {
        value: [
          1,
          {
            a: true,
          },
        ],
      }),
    ).toBe(true);
    expect(
      hits('state', 'flags = [1, {"a": true}]', 'flags', {
        value: [
          1,
          {
            a: false,
          },
        ],
      }),
    ).toBe(false);
    expect(
      hits('state', 'flags = [1]', 'flags', {
        value: [
          1,
          2,
        ],
      }),
    ).toBe(false);
    expect(
      hits('state', 'o = {"a": 1}', 'o', {
        value: {
          a: 1,
          b: 2,
        },
      }),
    ).toBe(false);
    expect(
      hits('state', 'o = {"a": 1}', 'o', {
        value: {
          b: 1,
        },
      }),
    ).toBe(false);
    expect(
      hits('state', 'o = {"a": 1}', 'o', {
        value: [
          1,
        ],
      }),
    ).toBe(false);
    expect(
      hits('state', 'x = null', 'x', {
        value: null,
      }),
    ).toBe(true);
    expect(hits('state', 'x = null', 'x')).toBe(false);
  });

  it('refuses malformed state matchers', () => {
    expect(reasonOf(parseSenseMatcher('state', ''))).toContain('not a state path');
    expect(reasonOf(parseSenseMatcher('state', 'cart..total'))).toContain('not a state path');
    expect(reasonOf(parseSenseMatcher('state', 'cart total'))).toContain('not a state path');
    expect(reasonOf(parseSenseMatcher('state', 'cart.total ='))).toContain('no value');
    expect(reasonOf(parseSenseMatcher('state', 'user.role = admin'))).toContain('JSON');
    expect(reasonOf(parseSenseMatcher('state', '= 1'))).toContain('not a state path');
  });
});

describe('signal sense', () => {
  it('formats and matches names exactly', () => {
    expect(formatSignalSummary(' order.placed ')).toBe('order.placed');
    expect(isSignalName('order.placed')).toBe(true);
    expect(matcher('signal', 'order.placed').summary).toBe('order.placed');
    expect(hits('signal', 'order.placed', 'order.placed')).toBe(true);
    expect(hits('signal', 'order.placed', 'order.placed.v2')).toBe(false);
  });

  it('refuses malformed names', () => {
    expect(reasonOf(parseSenseMatcher('signal', ''))).toContain('not a signal');
    expect(reasonOf(parseSenseMatcher('signal', 'order placed'))).toContain('not a signal');
    expect(reasonOf(parseSenseMatcher('signal', '.order'))).toContain('not a signal');
    expect(reasonOf(parseSenseMatcher('signal', '"order"'))).toContain('not a signal');
  });
});

describe('storage sense', () => {
  it('formats kind key, quoting keys that need it', () => {
    expect(
      formatStorageSummary({
        kind: 'local',
        key: 'session',
      }),
    ).toBe('local session');
    expect(
      formatStorageSummary({
        kind: 'cookie',
        key: 'my key',
      }),
    ).toBe('cookie "my key"');
    expect(parseStorageSummary('cookie "my key"')).toEqual({
      kind: 'cookie',
      key: 'my key',
    });
  });

  it('matches kind and key', () => {
    expect(matcher('storage', 'local session').summary).toBe('local session');
    expect(matcher('storage', 'cookie "a b"').summary).toBe('cookie "a b"');
    expect(hits('storage', 'local session', 'local session')).toBe(true);
    expect(hits('storage', 'local "session"', 'local session')).toBe(true);
    expect(hits('storage', 'local session', 'session session')).toBe(false);
    expect(hits('storage', 'local session', 'local token')).toBe(false);
    expect(hits('storage', 'local session', 'Local')).toBe(false);
  });

  it('refuses malformed storage matchers', () => {
    expect(reasonOf(parseSenseMatcher('storage', 'local'))).toContain('one key');
    expect(reasonOf(parseSenseMatcher('storage', ''))).toContain('kind');
    expect(reasonOf(parseSenseMatcher('storage', 'Local key'))).toContain('kind');
    expect(reasonOf(parseSenseMatcher('storage', '"local" key'))).toContain('kind');
    expect(reasonOf(parseSenseMatcher('storage', 'local a b'))).toContain('one key');
    expect(reasonOf(parseSenseMatcher('storage', 'local "a'))).toContain('Unterminated');
  });
});

describe('time sense', () => {
  it('formats settled and in-flight NAME', () => {
    expect(
      formatTimeSummary({
        state: 'settled',
      }),
    ).toBe('settled');
    expect(
      formatTimeSummary({
        state: 'in-flight',
        name: 'fetch orders',
      }),
    ).toBe('in-flight fetch-orders');
  });

  it('matches a word', () => {
    expect(matcher('time', 'settled').summary).toBe('settled');
    expect(matcher('time', 'in-flight').summary).toBeUndefined();
    expect(hits('time', 'settled', 'settled')).toBe(true);
    expect(hits('time', 'settled', 'in-flight x')).toBe(false);
    expect(hits('time', 'in-flight', 'in-flight fetch')).toBe(true);
    expect(hits('time', 'in-flight', 'settled')).toBe(false);
  });

  it('refuses other words', () => {
    expect(reasonOf(parseSenseMatcher('time', 'quiet'))).toContain('not a time word');
    expect(reasonOf(parseSenseMatcher('time', ''))).toContain('not a time word');
    expect(reasonOf(parseSenseMatcher('time', 'in-flight fetch'))).toContain('not a time word');
  });
});

describe('registry', () => {
  it('has a grammar for every named sense but visual', () => {
    expect(Object.keys(senseGrammars).sort()).toEqual([
      'log',
      'net',
      'route',
      'signal',
      'state',
      'storage',
      'time',
      'ui',
    ]);
    for (const [sense, grammar] of Object.entries(senseGrammars)) {
      expect(String(grammar.sense)).toBe(sense);
      expect(grammar.summaryFormat.length).toBeGreaterThan(0);
    }
  });

  it('visual has no matcher', () => {
    expect(VISUAL_SUMMARY).toBe('capture');
    expect(reasonOf(parseSenseMatcher('visual', 'capture'))).toContain('no matcher');
    expect(senseGrammarFor('visual')).toBeUndefined();
  });

  it('refuses unknown senses', () => {
    expect(reasonOf(parseSenseMatcher('pixels', 'x'))).toContain('not a sense');
    expect(reasonOf(parseSenseMatcher('x-', 'x'))).toContain('not a sense');
    expect(senseGrammarFor('nope')).toBeUndefined();
    expect(senseGrammarFor('toString')).toBeUndefined();
  });

  it('x- senses without a documented grammar match an exact summary', () => {
    const m = matcher('x-orders-db', ' orders.count ');
    expect(m.sense).toBe('x-orders-db');
    expect(m.summary).toBe('orders.count');
    expect(
      m.matches({
        summary: 'orders.count',
      }),
    ).toBe(true);
    expect(
      m.matches({
        summary: 'orders.total',
      }),
    ).toBe(false);
    expect(reasonOf(parseSenseMatcher('x-orders-db', '  '))).toContain('needs a summary');
    expect(exactSummaryGrammar('x-a').summaryFormat).toBe('summary');
  });

  it('extra grammars take precedence', () => {
    const custom = exactSummaryGrammar('x-custom');
    expect(
      senseGrammarFor('x-custom', {
        'x-custom': custom,
      }),
    ).toBe(custom);
    expect(
      senseGrammarFor('ui', {
        ui: custom,
      }),
    ).toBe(custom);
  });
});
