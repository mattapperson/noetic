import { describe, expect, test } from 'bun:test';
import type { ConnectionLease, SteeringDecision } from '@noetic-tools/types';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { createInMemoryConnection } from '../../src/connections/in-memory-connection';
import type { LeaseChange } from '../../src/connections/pool';
import { ConnectionPool } from '../../src/connections/pool';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryArtifactStore } from '../../src/runtime/in-memory-artifact-store';
import { makeLayer, makeStorage, sleep } from '../_helpers';

//#region Helpers

function pool(options: {
  readonly max?: number;
  readonly warm?: number;
  readonly renewMs?: number;
  readonly reclaimMs?: number;
  readonly now?: () => number;
  readonly failProvision?: boolean;
}): {
  readonly pool: ConnectionPool;
  readonly provider: ReturnType<typeof createInMemoryConnection>;
  readonly changes: Array<{
    readonly lease: ConnectionLease;
    readonly change: LeaseChange;
  }>;
} {
  const provider = createInMemoryConnection({
    provision: (setup) => {
      if (options.failProvision) {
        throw new Error('no capacity');
      }
      return {
        id: `p-${JSON.stringify(setup)}`,
      };
    },
  });
  const changes: Array<{
    lease: ConnectionLease;
    change: LeaseChange;
  }> = [];
  return {
    provider,
    changes,
    pool: new ConnectionPool({
      name: 'browsers',
      provider,
      config: {
        max: options.max ?? 2,
        warm: options.warm,
        waitMs: 20,
      },
      storage: makeStorage(),
      connectOptions: (signal) => ({
        name: 'browsers',
        signal,
        artifacts: createInMemoryArtifactStore(),
      }),
      onLease: (lease, change) =>
        changes.push({
          lease,
          change,
        }),
      now: options.now,
      renewMs: options.renewMs,
      reclaimMs: options.reclaimMs,
    }),
  };
}

function request(
  scopeKey: string,
  setup: Record<string, unknown> = {},
): Parameters<ConnectionPool['acquire']>[0] {
  return {
    scopeKey,
    scope: 'run',
    setup,
    signal: new AbortController().signal,
  };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

//#endregion

describe('ConnectionPool', () => {
  test('warm connections serve requests without setup; setup gets a fresh one', async () => {
    const { pool: p, provider } = pool({
      max: 2,
      warm: 1,
    });
    await p.start();
    expect(p.status()).toEqual({
      max: 2,
      leased: 0,
      idle: 1,
    });
    const warm = await p.acquire(request('a'));
    expect(warm.connection).toBe(provider.provisioned[0] ?? warm.connection);
    expect(provider.provisioned[0]?.setupGiven).toEqual({});
    const fresh = await p.acquire(
      request('b', {
        url: 'x',
      }),
    );
    expect(fresh.connection.id).toBe('p-{"url":"x"}');
    expect(provider.provisioned).toHaveLength(2);
    expect(p.holders()).toEqual([
      'a',
      'b',
    ]);
    await p.close();
    expect(provider.provisioned.every((c) => c.released)).toBe(true);
  });

  test('a full pool releases an idle warm connection to serve a request with setup', async () => {
    const { pool: p, provider } = pool({
      max: 1,
      warm: 1,
    });
    await p.start();
    const held = await p.acquire(
      request('a', {
        url: 'y',
      }),
    );
    expect(held.connection.id).toBe('p-{"url":"y"}');
    expect(provider.provisioned[0]?.released).toBe(true);
  });

  test('concurrent acquires for one scope share one lease', async () => {
    const { pool: p } = pool({});
    const [a, b] = await Promise.all([
      p.acquire(request('a')),
      p.acquire(request('a')),
    ]);
    expect(a.lease.id).toBe(b.lease.id);
  });

  test('provisioning failure is connection_unavailable', async () => {
    const { pool: p } = pool({
      failProvision: true,
    });
    const e = await rejected(p.acquire(request('a')));
    expect(isNoeticError(e) && e.noeticError.kind).toBe('connection_unavailable');
  });

  test('a closed pool refuses, and a cancelled wait is connection_unavailable', async () => {
    const { pool: p } = pool({
      max: 1,
    });
    await p.acquire(request('a'));
    const controller = new AbortController();
    const waiting = p.acquire({
      ...request('b'),
      signal: controller.signal,
    });
    controller.abort();
    const cancelled = await rejected(waiting);
    expect(isNoeticError(cancelled) && cancelled.noeticError.kind).toBe('connection_unavailable');
    await p.close();
    const closed = await rejected(p.acquire(request('c')));
    expect(isNoeticError(closed) && closed.noeticError.kind).toBe('connection_unavailable');
  });

  test('leases are renewed while held; one not renewed in time is reclaimed', async () => {
    let now = 1e6;
    const { pool: p, changes } = pool({
      renewMs: 5,
      reclaimMs: 100,
      now: () => now,
    });
    await p.start();
    const held = await p.acquire(request('a'));
    now += 50;
    await sleep(20);
    expect(changes.some((c) => c.change === 'renewed')).toBe(true);
    const renewed = p.heldBy('a');
    expect((renewed?.lease.expiresAt ?? 0) > held.lease.expiresAt).toBe(true);
    await p.close();

    let clock = 1e6;
    const stale = pool({
      renewMs: 1e6,
      reclaimMs: 10,
      now: () => clock,
    });
    await stale.pool.acquire(request('b'));
    clock += 11;
    await stale.pool.sweep();
    expect(stale.pool.heldBy('b')).toBeUndefined();
    expect(stale.changes.map((c) => c.change)).toEqual([
      'acquired',
      'reclaimed',
    ]);
  });

  test('an orphaned lease is not renewed and is reclaimed by the renew timer; re-acquiring adopts it again', async () => {
    let now = 1e6;
    const { pool: p, changes } = pool({
      renewMs: 5,
      reclaimMs: 30,
      now: () => now,
    });
    await p.start();
    await p.acquire(request('failed'));
    await p.acquire(request('resumed'));
    p.orphan('failed');
    p.orphan('resumed');
    await p.acquire(request('resumed'));
    now += 40;
    await sleep(25);
    expect(p.heldBy('failed')).toBeUndefined();
    expect(p.heldBy('resumed')).toBeDefined();
    expect(changes.some((c) => c.change === 'reclaimed' && c.lease.holder === 'failed')).toBe(true);
    await p.close();
  });
});

describe('harness gate wiring', () => {
  const allow: SteeringDecision = {
    action: 'allow',
  };

  test('approval goes to approveToolCall with the call context; refusals are steering_denied', async () => {
    const asked: string[] = [];
    const phone = createInMemoryConnection({
      operations: {
        wipe: {
          guarded: true,
          run: () => 'wiped',
        },
      },
    });
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone,
      },
      approveToolCall: async ({ toolName }) => {
        asked.push(toolName);
        return asked.length > 1
          ? {
              action: 'deny',
              guidance: 'not twice',
            }
          : allow;
      },
    });
    const ctx = harness.createContext();
    const registry = harness.connectionRegistry;
    if (!registry) {
      throw new Error('no registry');
    }
    const resolved = await registry.resolve({
      name: 'phone',
      scope: {
        executionId: ctx.id,
        threadId: ctx.threadId,
        scopeKey: ctx.id,
        signal: new AbortController().signal,
      },
    });
    const opts = {
      signal: new AbortController().signal,
      caller: 'step',
      idempotencyKey: 'k',
      ctx,
    } as const;
    expect(await resolved.call('wipe', {}, opts)).toBe('wiped');
    const denied = await rejected(resolved.call('wipe', {}, opts));
    expect(isNoeticError(denied) && denied.noeticError).toEqual({
      kind: 'steering_denied',
      guidance: 'not twice',
    });
    expect(asked).toEqual([
      'phone_wipe',
      'phone_wipe',
    ]);
    const noCtx = await rejected(
      resolved.call(
        'wipe',
        {},
        {
          ...opts,
          ctx: undefined,
        },
      ),
    );
    expect(isNoeticError(noCtx) && noCtx.noeticError.kind).toBe('steering_denied');
    await harness.closeConnections();
  });

  test('beforeToolCall layers gate step calls; an approver that throws denies', async () => {
    const phone = createInMemoryConnection({
      operations: {
        tap: {
          run: () => 'tapped',
        },
        wipe: {
          guarded: true,
          run: () => 'wiped',
        },
      },
    });
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone,
      },
      approveToolCall: async () => {
        throw new Error('approver down');
      },
      contextLayers: [
        makeLayer('gate', {
          hooks: {
            async beforeToolCall({ toolName }) {
              return {
                decision:
                  toolName === 'phone_tap'
                    ? {
                        action: 'deny',
                        guidance: 'hands off',
                      }
                    : allow,
              };
            },
          },
        }),
      ],
    });
    const ctx = harness.createContext();
    const resolved = await harness.connectionRegistry?.resolve({
      name: 'phone',
      scope: {
        executionId: ctx.id,
        threadId: ctx.threadId,
        scopeKey: ctx.id,
        signal: new AbortController().signal,
      },
    });
    if (!resolved) {
      throw new Error('no connection');
    }
    const opts = {
      signal: new AbortController().signal,
      caller: 'step',
      idempotencyKey: 'k',
      ctx,
    } as const;
    const tap = await rejected(resolved.call('tap', {}, opts));
    expect(isNoeticError(tap) && tap.noeticError).toEqual({
      kind: 'steering_denied',
      guidance: 'hands off',
    });
    const wipe = await rejected(resolved.call('wipe', {}, opts));
    const error = isNoeticError(wipe) ? wipe.noeticError : undefined;
    expect(error?.kind === 'steering_denied' && error.guidance).toContain('approver down');
    await harness.closeConnections();
  });

  test('without approveToolCall a guarded operation is refused', async () => {
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone: createInMemoryConnection({
          operations: {
            wipe: {
              guarded: true,
              run: () => 'wiped',
            },
          },
        }),
      },
    });
    const ctx = harness.createContext();
    const resolved = await harness.connectionRegistry?.resolve({
      name: 'phone',
      scope: {
        executionId: ctx.id,
        threadId: ctx.threadId,
        scopeKey: ctx.id,
        signal: new AbortController().signal,
      },
    });
    const e = await rejected(
      resolved?.call(
        'wipe',
        {},
        {
          signal: new AbortController().signal,
          caller: 'step',
          idempotencyKey: 'k',
          ctx,
        },
      ) ?? Promise.resolve(),
    );
    expect(isNoeticError(e) && e.noeticError.kind).toBe('steering_denied');
    expect(isNoeticConfigError(e)).toBe(false);
  });
});
