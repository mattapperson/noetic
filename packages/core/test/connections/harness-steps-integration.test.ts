// End-to-end wiring (specs 35 and 37): the real AgentHarness, its connection
// registry and in-memory connections, driven by `step.call`, `step.wait` and
// `step.verify` — no fake registry. Checks the pieces each slice left to the
// harness: the registry the steps find, the verifier and artifact store the
// verify step reads, and pool leases returned when a run ends.

import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { Step } from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { inParallel } from '../../src/builders/control-flow-builders';
import { loop } from '../../src/builders/loop-builder';
import { runCode, step } from '../../src/builders/step-builders';
import { connection } from '../../src/connections/handle';
import { createInMemoryConnection } from '../../src/connections/in-memory-connection';
import { AgentHarness } from '../../src/harness/agent-harness';
import { until } from '../../src/until/predicates';
import { harnessInternal } from '../../src/util/harness-internals';
import { makeLayer } from '../_helpers';

//#region Helpers

function phone(): ReturnType<typeof createInMemoryConnection> {
  return createInMemoryConnection({
    operations: {
      'phone.ping': {
        run: (args) => ({
          pong: frameworkCast<{
            n?: number;
          }>(args).n,
        }),
      },
    },
  });
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

//#endregion

describe('harness ↔ connection steps', () => {
  test('a run() root is negotiated before it executes: a missing operation is CONNECTION_UNSATISFIED', async () => {
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone: phone(),
      },
    });
    let ranFirst = false;
    const first = runCode({
      id: 'first',
      execute: async () => {
        ranFirst = true;
        return undefined;
      },
    });
    const missing = step.call({
      id: 'missing',
      connection: connection('phone'),
      op: 'phone.vibrate',
    });
    const e = await rejected(
      harness.run(
        [
          first,
          missing,
        ],
        undefined,
        harness.createContext(),
      ),
    );
    assert(isNoeticConfigError(e));
    expect(e.code).toBe('CONNECTION_UNSATISFIED');
    expect(ranFirst).toBe(false);
    await harness.close();
  });

  test('step.call reaches a harness connection by handle and by name', async () => {
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone: phone(),
      },
    });
    const byHandle = step.call({
      id: 'by-handle',
      connection: connection('phone'),
      op: 'phone.ping',
      args: {
        n: 1,
      },
    });
    const byName = step.call({
      id: 'by-name',
      connection: 'phone',
      op: 'phone.ping',
      args: (input: number) => ({
        n: input,
      }),
    });
    const ctx = harness.createContext();
    expect(await harness.run(byHandle, undefined, ctx)).toEqual({
      pong: 1,
    });
    expect(await harness.run(byName, 7, harness.createContext())).toEqual({
      pong: 7,
    });
    expect(ctx.lastStepMeta).toBeDefined();
    await harness.close();
  });

  test('harness.run(array) runs the steps in sequence, each output the next input', async () => {
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone: phone(),
      },
    });
    const output = await harness.run(
      [
        step.call({
          id: 'first',
          connection: 'phone',
          op: 'phone.ping',
          args: {
            n: 1,
          },
        }),
        step.call({
          id: 'second',
          connection: 'phone',
          op: 'phone.ping',
          args: (input: { pong?: number }) => ({
            n: (input.pong ?? 0) + 1,
          }),
        }),
      ],
      undefined,
      harness.createContext(),
    );
    expect(output).toEqual({
      pong: 2,
    });
    await harness.close();
  });

  test('step.call on a connection the harness lacks is CONNECTION_UNKNOWN', async () => {
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone: phone(),
      },
    });
    const e = await rejected(
      harness.run(
        step.call({
          id: 'nope',
          connection: 'fax',
          op: 'phone.ping',
        }),
        undefined,
        harness.createContext(),
      ),
    );
    assert(isNoeticConfigError(e));
    expect(e.code).toBe('CONNECTION_UNKNOWN');
    await harness.close();
  });

  test('step.wait receives an event emitted by the connection during `around`', async () => {
    const source = createInMemoryConnection({
      events: {
        'deploy.failed': {},
      },
    });
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        deploys: source,
      },
    });
    const graph = step.wait({
      id: 'wait',
      connection: 'deploys',
      event: 'deploy.failed',
      timeoutMs: 1e3,
      around: {
        kind: 'runCode',
        id: 'emit',
        execute: async () => {
          source.connection.emit('deploy.failed', {
            service: 'api',
          });
          return undefined;
        },
      } satisfies Step,
    });
    const output = await harness.run(graph, undefined, harness.createContext());
    expect(output.event.type).toBe('deploy.failed');
    expect(output.event.payload).toEqual({
      service: 'api',
    });
    await harness.close();
  });

  test('step.call runs gate 5: the approver is asked for approve-policy ops, and steering layers refuse', async () => {
    const asked: string[] = [];
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone: {
          provider: createInMemoryConnection({
            operations: {
              'phone.ping': {
                run: () => 'pong',
              },
              'phone.wipe': {
                run: () => 'wiped',
              },
            },
          }),
          policy: {
            approve: [
              'phone.ping',
            ],
          },
        },
      },
      approveToolCall: async ({ toolName }) => {
        asked.push(toolName);
        return {
          action: 'allow',
        };
      },
      contextLayers: [
        makeLayer('gate', {
          hooks: {
            async beforeToolCall({ toolName }) {
              return {
                decision:
                  toolName === 'phone_phone_wipe'
                    ? {
                        action: 'deny',
                        guidance: 'no wiping',
                      }
                    : {
                        action: 'allow',
                      },
              };
            },
          },
        }),
      ],
    });
    const ping = step.call({
      id: 'ping',
      connection: 'phone',
      op: 'phone.ping',
    });
    expect(await harness.run(ping, undefined, harness.createContext())).toBe('pong');
    expect(asked).toEqual([
      'phone_phone_ping',
    ]);
    const wipe = await rejected(
      harness.run(
        step.call({
          id: 'wipe',
          connection: 'phone',
          op: 'phone.wipe',
        }),
        undefined,
        harness.createContext(),
      ),
    );
    assert(isNoeticError(wipe));
    expect(wipe.noeticError).toEqual({
      kind: 'steering_denied',
      guidance: 'no wiping',
    });
    await harness.close();
  });

  test('step.call reports long-operation progress once, with its step id', async () => {
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone: createInMemoryConnection({
          operations: {
            'phone.build': {
              task: [
                {
                  state: 'working',
                },
              ],
              run: () => 'built',
            },
          },
        }),
      },
    });
    const events: Array<{
      type: string;
      data: Record<string, unknown>;
    }> = [];
    const ctx = harness.createContext();
    frameworkCast<{
      _broadcaster: unknown;
    }>(ctx)._broadcaster = {
      emit(event: { type: string; data: Record<string, unknown> }) {
        events.push(event);
      },
    };
    const graph = step.call({
      id: 'build',
      connection: 'phone',
      op: 'phone.build',
    });
    expect(await harness.run(graph, undefined, ctx)).toBe('built');
    const tasks = events.filter((e) => e.type === 'agent:connection_task');
    expect(
      tasks.map(
        (e) =>
          frameworkCast<{
            state: string;
          }>(e.data.status).state,
      ),
    ).toEqual([
      'working',
      'completed',
    ]);
    expect(tasks.every((e) => e.data.stepId === 'build')).toBe(true);
    await harness.close();
  });

  test('step.wait: each received event and gap reaches the run once, from the registry', async () => {
    const source = createInMemoryConnection({
      events: {
        'deploy.failed': {},
      },
    });
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        deploys: source,
      },
    });
    const events: Array<{
      type: string;
      data: Record<string, unknown>;
    }> = [];
    const ctx = harness.createContext();
    frameworkCast<{
      _broadcaster: unknown;
    }>(ctx)._broadcaster = {
      emit(event: { type: string; data: Record<string, unknown> }) {
        events.push(event);
      },
    };
    const graph = step.wait({
      id: 'wait',
      connection: 'deploys',
      event: 'deploy.failed',
      timeoutMs: 1e3,
      around: {
        kind: 'runCode',
        id: 'emit',
        execute: async () => {
          source.connection.gap('server skipped events');
          source.connection.emit('deploy.failed', {
            service: 'api',
          });
          return undefined;
        },
      } satisfies Step,
    });
    await harness.run(graph, undefined, ctx);
    expect(events.filter((e) => e.type === 'agent:connection_event')).toHaveLength(1);
    const gaps = events.filter((e) => e.type === 'agent:stream_changed');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.data.change).toBe('gap');
    await harness.close();
  });

  test("a run's fresh pool lease is returned when the run completes", async () => {
    const provider = createInMemoryConnection({
      operations: {
        'browser.ping': {
          run: () => 'pong',
        },
      },
      provision: () => undefined,
    });
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        browsers: {
          provider,
          pool: {
            max: 1,
            waitMs: 20,
          },
        },
      },
    });
    const graph = step.call({
      id: 'leased',
      connection: connection('browsers', undefined, {
        fresh: 'run',
      }),
      op: 'browser.ping',
    });
    expect(await harness.run(graph, undefined, harness.createContext())).toBe('pong');
    expect(provider.provisioned).toHaveLength(1);
    expect(provider.provisioned[0]?.released).toBe(true);
    expect(harness.getConnectionStatus('browsers')[0]?.pool?.leased).toBe(0);
    // One slot: the second run gets a connection only because the first returned its lease.
    expect(await harness.run(graph, undefined, harness.createContext())).toBe('pong');
    expect(harness.getConnectionStatus('browsers')[0]?.pool?.leased).toBe(0);
    await harness.close();
  });
});

describe('negotiating run() roots', () => {
  function counted(counter: { ran: number }): Step {
    return runCode({
      id: 'first',
      execute: async () => {
        counter.ran += 1;
        return undefined;
      },
    });
  }

  test('a root needing an operation a warm pool lacks fails before its earlier steps run', async () => {
    const provider = createInMemoryConnection({
      operations: {
        'browser.ping': {
          run: () => 'pong',
        },
      },
      provision: () => undefined,
    });
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        browsers: {
          provider,
          pool: {
            max: 1,
            warm: 1,
          },
        },
      },
    });
    const counter = {
      ran: 0,
    };
    const root = loop({
      id: 'flow',
      steps: [
        counted(counter),
        step.call({
          id: 'missing',
          connection: connection('browsers', undefined, {
            fresh: 'run',
          }),
          op: 'browser.missing',
        }),
      ],
      until: until.maxSteps(1),
    });
    const e = await rejected(harness.run(root, undefined, harness.createContext()));
    assert(isNoeticConfigError(e));
    expect(e.code).toBe('CONNECTION_UNSATISFIED');
    expect(counter.ran).toBe(0);
    await harness.close();
  });

  test('a pool need that passes a setup is checked on its lease, not against another setup', async () => {
    const basicOps = {
      'basic.op': {
        run: () => 'basic',
      },
    };
    const provider = createInMemoryConnection({
      operations: basicOps,
      provision: (setup) =>
        setup.mode === 'rich'
          ? {
              operations: {
                ...basicOps,
                'rich.op': {
                  run: () => 'rich',
                },
              },
            }
          : {
              operations: basicOps,
            },
    });
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        pool: {
          provider,
          pool: {
            max: 4,
          },
        },
      },
    });
    const callOn = (mode: string, op: string): Step =>
      step.call({
        id: `${mode}-call`,
        connection: connection('pool', undefined, {
          fresh: 'run',
          setup: {
            mode,
          },
        }),
        op,
      });
    expect(await harness.run(callOn('basic', 'basic.op'), undefined, harness.createContext())).toBe(
      'basic',
    );
    expect(await harness.run(callOn('rich', 'rich.op'), undefined, harness.createContext())).toBe(
      'rich',
    );
    await harness.close();
  });

  test('a root negotiated while its connection was down is negotiated again once it is back', async () => {
    const provider = phone();
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone: provider,
      },
    });
    await harness.start();
    provider.connection.drop('server crashed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const counter = {
      ran: 0,
    };
    const root = loop({
      id: 'flow',
      steps: [
        counted(counter),
        step.call({
          id: 'missing',
          connection: connection('phone'),
          op: 'phone.vibrate',
        }),
      ],
      until: until.maxSteps(1),
    });
    // Down at negotiation: nothing to check, so the step itself fails, after `first` ran.
    await rejected(harness.run(root, undefined, harness.createContext()));
    expect(counter.ran).toBe(1);
    expect(harness.getConnectionStatus('phone')[0]?.state).toBe('ready');
    // Back up: the same root is now negotiated before it executes.
    const e = await rejected(harness.run(root, undefined, harness.createContext()));
    assert(isNoeticConfigError(e));
    expect(e.code).toBe('CONNECTION_UNSATISFIED');
    expect(counter.ran).toBe(1);
    await harness.close();
  });
});

describe('closing the harness', () => {
  test('close() still closes ACP sessions when closing connections throws, then rethrows', async () => {
    const provider = phone();
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone: provider,
      },
      triggers: [],
    });
    await harness.start();
    const registry = harnessInternal<{
      close(): Promise<void>;
    }>(harness, 'connectionRegistry');
    assert(registry);
    const closeRegistry = registry.close.bind(registry);
    registry.close = async () => {
      await closeRegistry();
      throw new Error('registry close failed');
    };
    let acpClosed = false;
    harness.closeAcpSessions = async () => {
      acpClosed = true;
    };
    const e = await rejected(harness.close());
    assert(e instanceof Error);
    expect(e.message).toBe('registry close failed');
    expect(acpClosed).toBe(true);
    expect(provider.connection.released).toBe(true);
  });
});

describe('graph requirements', () => {
  test("the agent graph's handle requirements are negotiated at start", async () => {
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone: phone(),
      },
      agentGraph: frameworkCast<
        Step<Readonly<Record<string, Record<string, unknown>>>, string, string>
      >(
        step.call({
          id: 'needs-missing',
          connection: connection('phone'),
          op: 'phone.missing',
        }),
      ),
    });
    await harness.start();
    const status = harness.getConnectionStatus('phone')[0];
    expect(status?.state).toBe('unavailable');
    expect(status?.reason).toContain('phone.missing');
    await harness.close();
  });
});

describe('fresh path leases', () => {
  test("an inParallel path's fresh: 'path' lease is returned when the path ends, so a loop never exhausts the pool", async () => {
    const provider = createInMemoryConnection({
      operations: {
        'browser.ping': {
          run: () => 'pong',
        },
      },
      provision: () => undefined,
    });
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        browsers: {
          provider,
          pool: {
            max: 2,
            waitMs: 20,
          },
        },
      },
    });
    const fanOut = inParallel({
      id: 'fan',
      mode: 'all',
      paths: () =>
        [
          'a',
          'b',
        ].map((id) =>
          step.call({
            id: `ping-${id}`,
            connection: connection('browsers', undefined, {
              fresh: 'path',
            }),
            op: 'browser.ping',
          }),
        ),
      merge: (results: unknown[]) => results,
    });
    const graph = loop({
      id: 'again',
      steps: [
        fanOut,
      ],
      until: until.maxSteps(3),
    });
    await harness.run(graph, undefined, harness.createContext());
    // Three passes of two paths through a pool of two: each pass got its connections back.
    expect(provider.provisioned).toHaveLength(6);
    expect(provider.provisioned.every((c) => c.released)).toBe(true);
    expect(harness.getConnectionStatus('browsers')[0]?.pool?.leased).toBe(0);
    await harness.close();
  });
});

describe('harness ↔ verify step', () => {
  test('without a verifier the harness refuses a verify with VERIFY_NOT_CONFIGURED', async () => {
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone: phone(),
      },
    });
    expect(harnessInternal(harness, 'verifier')).toBeUndefined();
    const e = await rejected(
      harness.run(
        step.verify({
          id: 'check',
          subject: 'phone',
          expect: [
            {
              kind: 'sense',
              sense: 'net',
              match: 'POST /api/orders 201',
            },
          ],
          act: step.call({
            id: 'act',
            connection: 'phone',
            op: 'phone.ping',
          }),
        }),
        undefined,
        harness.createContext(),
      ),
    );
    assert(isNoeticConfigError(e));
    expect(e.code).toBe('VERIFY_NOT_CONFIGURED');
    await harness.close();
  });
});
