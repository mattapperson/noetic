import { describe, expect, it } from 'bun:test';
import type { ConformanceDriver, ConformanceReport } from '../src/conformance';
import { checkConformance, conformanceLevel, matchesSenseSummary } from '../src/conformance';
import { mcp } from '../src/provider';
import { TestServer, textResult } from './_helpers';
import type { KioskState } from './_profiles';
import { kiosk, kioskServerOptions, kioskState } from './_profiles';

function statuses(report: ConformanceReport): Record<string, string> {
  return Object.fromEntries(
    report.results.map((r) => [
      r.id,
      r.status,
    ]),
  );
}

function fullDriver(fixture: TestServer, state: KioskState): ConformanceDriver {
  return {
    sample: async (op) => {
      if (op === 'ui.tap') {
        return {
          element: 'button "Print"',
        };
      }
      if (op === 'kiosk.print') {
        return {
          text: 'ticket',
        };
      }
      return undefined;
    },
    alternate: async () => ({
      text: 'another ticket',
    }),
    confirm: async (_op, receipt) => receipt.actionId.startsWith('a'),
    ambiguous: async () => ({
      op: 'ui.tap',
      args: {
        element: 'button',
      },
    }),
    replace: async () => {
      state.instance = 'kiosk-replaced';
      await fixture.emit({
        eventId: 'replaced-1',
        name: 'identity.changed',
        data: {},
      });
      return true;
    },
    healthyClaim: async () => 'yes',
    masked: async () => true,
    summaries: async () => [
      {
        sense: 'ui',
        summary: 'button "Print"',
      },
      {
        sense: 'net',
        summary: 'POST /api/orders 201',
      },
    ],
  };
}

describe('checkConformance', () => {
  it('passes a conforming server with a complete driver', async () => {
    const state = kioskState();
    const fixture = new TestServer(kioskServerOptions(state));
    const report = await checkConformance({
      server: fixture.provider({
        profiles: [
          kiosk,
        ],
      }),
      profile: kiosk,
      driver: fullDriver(fixture, state),
    });
    const failures = report.results.filter((r) => r.status !== 'pass');
    expect(failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.profile).toBe('kiosk@1');
    expect(report.level).toBe('none');
    expect(statuses(report)).toMatchObject({
      'declaration.profile': 'pass',
      'declaration.parent.ui': 'pass',
      'declaration.operation.kiosk.print': 'pass',
      'declaration.read.ui.summary': 'pass',
      'declaration.event.kiosk.printed': 'pass',
      'identity.replacement': 'pass',
      'errors.malformed': 'pass',
      'errors.undeclared': 'pass',
      'errors.ambiguous': 'pass',
      'effects.ui.tap': 'pass',
      'effects.ui.tap.confirmed': 'pass',
      'once.kiosk.print.replay': 'pass',
      'once.kiosk.print.conflict': 'pass',
      'claim.healthy': 'pass',
      'sensitive.masked': 'pass',
      summaries: 'pass',
    });
    expect(report.results.some((r) => r.id === 'declaration.operation.ui.drag')).toBe(false);
  });

  it('scores what the driver cannot set up as absent, which is not a pass', async () => {
    const state = kioskState();
    const fixture = new TestServer(kioskServerOptions(state));
    const report = await checkConformance({
      server: fixture.provider(),
      profile: kiosk,
    });
    expect(report.passed).toBe(false);
    expect(statuses(report)).toMatchObject({
      'declaration.profile': 'pass',
      'identity.replacement': 'absent',
      'errors.ambiguous': 'absent',
      'effects.ui.tap': 'absent',
      'claim.healthy': 'absent',
      'sensitive.masked': 'absent',
      summaries: 'absent',
    });
  });

  it('names each failure with the profile part it comes from', async () => {
    const state = kioskState();
    const fixture = new TestServer(kioskServerOptions(state));
    const report = await checkConformance({
      server: fixture.provider(),
      profile: kiosk,
      driver: {
        ...fullDriver(fixture, state),
        confirm: async () => false,
        replace: async () => true,
        healthyClaim: async () => 'unknown',
        masked: async () => false,
        summaries: async () => [
          {
            sense: 'net',
            summary: 'post /api/orders',
          },
        ],
      },
      identityTimeoutMs: 20,
    });
    expect(report.passed).toBe(false);
    const byId = new Map(
      report.results.map((r) => [
        r.id,
        r,
      ]),
    );
    expect(byId.get('effects.ui.tap.confirmed')).toMatchObject({
      status: 'fail',
      part: 'ui.tap effects',
    });
    expect(byId.get('identity.replacement')?.message).toContain('OVP-SUBJ-1');
    expect(byId.get('claim.healthy')).toMatchObject({
      status: 'fail',
      part: 'OVP-CONF-2',
    });
    expect(byId.get('sensitive.masked')?.status).toBe('fail');
    expect(byId.get('summaries')?.message).toContain("net 'post /api/orders'");
  });

  it('fails a server that does not speak the profile', async () => {
    const fixture = new TestServer({
      tools: [
        {
          name: 'ui.tap',
          handler: () => textResult('tapped'),
        },
      ],
    });
    const report = await checkConformance({
      server: fixture.provider(),
      profile: kiosk,
    });
    expect(statuses(report)).toMatchObject({
      'declaration.profile': 'fail',
      'declaration.parent.ui': 'fail',
      'declaration.operation.kiosk.print': 'fail',
      'declaration.operation.ui.tap': 'pass',
    });
    expect(report.passed).toBe(false);
  });

  it('reports a server it cannot connect to', async () => {
    const report = await checkConformance({
      server: mcp({
        transport: () => {
          throw new Error('nothing listening');
        },
      }),
      profile: kiosk,
    });
    expect(report.passed).toBe(false);
    expect(report.results[0]).toMatchObject({
      id: 'connect',
      status: 'fail',
    });
  });

  it('accepts an mcp() configuration and builds the provider with the profile catalog', async () => {
    const state = kioskState();
    const fixture = new TestServer(kioskServerOptions(state));
    const provider = fixture.provider();
    const config = provider.config.target;
    if (!('transport' in config)) {
      throw new Error('expected a transport target');
    }
    const report = await checkConformance({
      server: {
        transport: config.transport,
      },
      profile: kiosk,
    });
    expect(statuses(report)['declaration.profile']).toBe('pass');
  });
});

describe('sense summary formats', () => {
  it('matches the § Senses table', () => {
    expect(matchesSenseSummary('ui', 'button "Pay"')).toBe(true);
    expect(matchesSenseSummary('ui', 'heading')).toBe(true);
    expect(matchesSenseSummary('net', 'GET /api/x 200')).toBe(true);
    expect(matchesSenseSummary('net', 'GET /api/x')).toBe(false);
    expect(matchesSenseSummary('log', 'error Uncaught TypeError: x is undefined')).toBe(true);
    expect(matchesSenseSummary('route', '/checkout/done')).toBe(true);
    expect(matchesSenseSummary('route', 'checkout')).toBe(false);
    expect(matchesSenseSummary('state', 'cart.items')).toBe(true);
    expect(matchesSenseSummary('signal', 'order.placed')).toBe(true);
    expect(matchesSenseSummary('storage', 'local session')).toBe(true);
    expect(matchesSenseSummary('time', 'settled')).toBe(true);
    expect(matchesSenseSummary('time', 'in-flight fetch')).toBe(true);
    expect(matchesSenseSummary('visual', 'capture')).toBe(true);
    expect(matchesSenseSummary('x-exit', 'anything')).toBe(true);
    expect(matchesSenseSummary('bogus', 'anything')).toBe(false);
  });

  it('derives the OVP conformance level from the declared senses', () => {
    expect(
      conformanceLevel([
        'ui',
      ]),
    ).toBe('none');
    expect(
      conformanceLevel([
        'net',
        'log',
      ]),
    ).toBe('effect');
    expect(
      conformanceLevel([
        'net',
        'log',
        'state',
        'signal',
      ]),
    ).toBe('in-realm');
    expect(
      conformanceLevel([
        'net',
        'log',
        'state',
        'signal',
        'ui',
      ]),
    ).toBe('surface');
  });
});
