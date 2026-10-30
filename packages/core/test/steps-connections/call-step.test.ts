// `step.call` (spec 35 § Steps): builder validation, typing by profile, and
// execution through the harness connection registry.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ConnectionHandle, ContextData } from '@noetic-tools/types';
import {
  defineProfile,
  isNoeticConfigError,
  isNoeticError,
  NoeticErrorImpl,
  receipt,
  secret,
  sensitive,
  target,
} from '@noetic-tools/types';
import { z } from 'zod';
import { step } from '../../src/builders/step-builders';
import { stepChildren } from '../../src/interpreter/step-walk';
import { capturingContext, FakeRegistry, harnessWith } from './_helpers';

//#region Fixtures

const ui = defineProfile({
  name: 'ui',
  version: '1.1.0',
  operations: {
    'ui.fill': {
      description: 'Fill a field.',
      input: z.object({
        element: target('ui.element'),
        text: sensitive(z.string()),
      }),
      output: z.object({
        receipt: receipt(),
      }),
      effects: true,
    },
    'ui.count': {
      description: 'Count elements.',
      input: z.object({
        element: z.string(),
      }),
      output: z.object({
        count: z.number(),
      }),
    },
  },
});

function handle(name: string, from?: string): ConnectionHandle<typeof ui> {
  return {
    kind: 'connection-handle',
    name,
    profile: ui,
    options: from
      ? {
          from,
          fresh: 'path',
          setup: {
            url: 'http://localhost:5173',
          },
        }
      : {},
  };
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

//#endregion

describe('step.call builder', () => {
  it('builds a call step', () => {
    const built = step.call({
      id: 'count',
      connection: 'app',
      op: 'ui.count',
      args: {
        element: 'button',
      },
    });
    expect(built.kind).toBe('call');
    expect(built.op).toBe('ui.count');
    expect(stepChildren(built)).toEqual([]);
  });

  it('rejects an empty id with EMPTY_STEP_ID', () => {
    expectConfigCode(
      () =>
        step.call({
          id: ' ',
          connection: 'app',
          op: 'ui.tap',
        }),
      'EMPTY_STEP_ID',
    );
  });

  it('rejects a missing connection with CONNECTION_INVALID', () => {
    expectConfigCode(
      () =>
        step.call({
          id: 'x',
          connection: '',
          op: 'ui.tap',
        }),
      'CONNECTION_INVALID',
    );
  });

  it('rejects an operation name without a dot with CONNECTION_INVALID', () => {
    expectConfigCode(
      () =>
        step.call({
          id: 'x',
          connection: 'app',
          op: 'tap',
        }),
      'CONNECTION_INVALID',
    );
  });

  it('types op, args and output by the handle profile', () => {
    const built = step.call({
      id: 'fill',
      connection: handle('app'),
      op: 'ui.fill',
      args: {
        element: 'textbox "Password"',
        text: secret('app.password'),
      },
    });
    // The phantom output type is the profile operation's output.
    const output:
      | {
          receipt: {
            actionId: string;
            cursor: string | null;
          };
        }
      | undefined = built._output;
    expect(output).toBeUndefined();
    expect(built.connection).toEqual(handle('app'));
  });
});

describe('executeCall', () => {
  it('runs the operation through the registry and returns its output', async () => {
    const registry = new FakeRegistry({
      app: {
        ops: {
          'ui.count': () => ({
            count: 3,
          }),
        },
      },
    });
    const harness = harnessWith(registry);
    const ctx = harness.createContext();
    const output = await harness.run(
      step.call<ContextData, string>({
        id: 'count',
        connection: 'app',
        op: 'ui.count',
        args: (input) => ({
          element: input,
        }),
      }),
      'button',
      ctx,
    );
    expect(output).toEqual({
      count: 3,
    });
    expect(registry.calls).toHaveLength(1);
    const call = registry.calls[0];
    assert(call);
    expect(call.op).toBe('ui.count');
    expect(call.args).toEqual({
      element: 'button',
    });
    expect(call.opts.caller).toBe('step');
    expect(call.opts.stepId).toBe('count');
    expect(call.opts.declaredOps).toEqual([
      'ui.count',
    ]);
    expect(call.opts.idempotencyKey.startsWith(`${ctx.id}:`)).toBe(true);
    expect(ctx.stepCount).toBeGreaterThan(0);
  });

  it('passes a handle requirement, pool and setup to the registry', async () => {
    const registry = new FakeRegistry({
      browsers: {},
    });
    const harness = harnessWith(registry);
    await harness.run(
      step.call({
        id: 'fill',
        connection: handle('app', 'browsers'),
        op: 'ui.fill',
        args: {
          element: 'textbox "Email"',
          text: 'qa@example.com',
        },
      }),
      '',
      harness.createContext(),
    );
    const request = registry.resolves[0];
    assert(request);
    expect(request.name).toBe('app');
    expect(request.from).toBe('browsers');
    expect(request.fresh).toBe('path');
    expect(request.setup).toEqual({
      url: 'http://localhost:5173',
    });
    expect(request.requirement).toEqual({
      profile: {
        name: 'ui',
        range: '^1.1.0',
      },
      operations: [
        'ui.fill',
      ],
    });
    // A path-scoped lease is keyed under the run.
    expect(request.scope.scopeKey).toContain(':path:');
  });

  it('gives the same idempotency key to repeated dispatches of one path only once per path', async () => {
    const registry = new FakeRegistry({
      app: {},
    });
    const harness = harnessWith(registry);
    const ctx = harness.createContext();
    const call = step.call({
      id: 'tap',
      connection: 'app',
      op: 'ui.tap',
    });
    await harness.run(call, '', ctx);
    await harness.run(call, '', ctx);
    const [first, second] = registry.calls;
    assert(first && second);
    // Two dispatches are two occurrences on the run, so two keys.
    expect(first.opts.idempotencyKey).not.toBe(second.opts.idempotencyKey);
  });

  it('fails with CONNECTION_UNKNOWN when the harness has no connections', async () => {
    const harness = harnessWith(undefined);
    await expectRejectsConfig(
      harness.run(
        step.call({
          id: 'tap',
          connection: 'app',
          op: 'ui.tap',
        }),
        '',
        harness.createContext(),
      ),
      'CONNECTION_UNKNOWN',
    );
  });

  it('surfaces a connection_failed error from the registry', async () => {
    const registry = new FakeRegistry({
      app: {
        ops: {
          'ui.tap': () => {
            throw new NoeticErrorImpl({
              kind: 'connection_failed',
              connection: 'app',
              op: 'ui.tap',
              error: {
                code: 'ambiguous',
                message: 'two buttons match',
              },
            });
          },
        },
      },
    });
    const harness = harnessWith(registry);
    try {
      await harness.run(
        step.call({
          id: 'tap',
          connection: 'app',
          op: 'ui.tap',
        }),
        '',
        harness.createContext(),
      );
      expect.unreachable('expected connection_failed');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('connection_failed');
    }
  });

  it('surfaces a steering_denied refusal from the gates', async () => {
    const registry = new FakeRegistry({
      app: {
        ops: {
          'ui.tap': () => {
            throw new NoeticErrorImpl({
              kind: 'steering_denied',
              guidance: 'guarded',
            });
          },
        },
      },
    });
    const harness = harnessWith(registry);
    try {
      await harness.run(
        step.call({
          id: 'tap',
          connection: 'app',
          op: 'ui.tap',
        }),
        '',
        harness.createContext(),
      );
      expect.unreachable('expected steering_denied');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('steering_denied');
    }
  });

  it('passes its context and step id to the registry, which reports connection_task', async () => {
    let seenTask = false;
    const registry = new FakeRegistry({
      app: {
        ops: {
          'app.install': (_args, opts) => {
            opts.onTask?.({
              taskId: 't1',
              state: 'working',
            });
            seenTask = true;
            return {
              installed: true,
            };
          },
        },
      },
    });
    const harness = harnessWith(registry, 'task-agent');
    const { ctx } = capturingContext(harness);
    const output = await harness.run(
      step.call({
        id: 'install',
        connection: 'app',
        op: 'app.install',
      }),
      '',
      ctx,
    );
    expect(output).toEqual({
      installed: true,
    });
    expect(seenTask).toBe(true);
    const call = registry.calls[0];
    assert(call);
    // Gate 5 needs the context (steering layers, the approver); the registry emits progress to it.
    expect(call.opts.ctx).toBeDefined();
    expect(call.opts.stepId).toBe('install');
    expect(registry.resolves[0]?.ctx).toBeDefined();
  });
});
