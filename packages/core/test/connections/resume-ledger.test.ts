// Resuming a run against connections (spec 35 § Durability), end to end through
// the real AgentHarness, registry and durable ledger: a replaced connection
// discards the ledger from the first step that used it, `harness.restore(id,
// { rerun })` lets an unsafe one run live, an undeclared determinism is unsafe,
// and a call whose long operation already started waits on that task.

import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { Determinism, Step } from '@noetic-tools/types';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { loop } from '../../src/builders/loop-builder';
import { runCode, step } from '../../src/builders/step-builders';
import { connection } from '../../src/connections/handle';
import type { InMemoryConnectionProvider } from '../../src/connections/in-memory-connection';
import { createInMemoryConnection } from '../../src/connections/in-memory-connection';
import type { ConnectionRuntime } from '../../src/connections/registry';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { until } from '../../src/until/predicates';
import { harnessInternal } from '../../src/util/harness-internals';

function registryOf(harness: object): ConnectionRuntime | undefined {
  return harnessInternal<ConnectionRuntime>(harness, 'connectionRegistry');
}

//#region Helpers

type Storage = ReturnType<typeof createInMemoryStorage>;

interface Rig {
  /** `<instance>:<op>` for every call a connection received. */
  readonly calls: string[];
  readonly resets: string[];
  /** While true, `ui.tap` fails (as a crash mid-run would leave it). */
  failTap: boolean;
}

function determinism(replayPrefix: Determinism['replayPrefix']): Determinism {
  return {
    reset: replayPrefix === 'unsafe' ? 'none' : 'cheap',
    replayPrefix,
    time: 'wall',
    observation: 'exact',
    actions: 'reversible',
  };
}

function app(
  rig: Rig,
  instance: string,
  replay: Determinism['replayPrefix'] | undefined,
): InMemoryConnectionProvider {
  return createInMemoryConnection({
    instance,
    ...(replay
      ? {
          determinism: determinism(replay),
        }
      : {}),
    reset: () => {
      rig.resets.push(instance);
    },
    operations: {
      'ui.fill': {
        effects: true,
        run: () => {
          rig.calls.push(`${instance}:ui.fill`);
          return 'filled';
        },
      },
      'ui.tap': {
        effects: true,
        run: () => {
          rig.calls.push(`${instance}:ui.tap`);
          if (rig.failTap) {
            throw new Error('crashed');
          }
          return 'tapped';
        },
      },
    },
  });
}

function harnessFor(storage: Storage, provider: InMemoryConnectionProvider): AgentHarness {
  return new AgentHarness({
    name: 'resume',
    params: {},
    connections: {
      app: provider,
    },
    environment: {
      storage: {
        adapter: storage,
        checkpointStore: createCheckpointStore({
          storage,
        }),
      },
    },
  });
}

/** `ui.fill` then `ui.tap`, as one loop pass (an array of steps runs in sequence). */
function sequence(): Step {
  return loop({
    id: 'flow',
    steps: [
      step.call({
        id: 'fill',
        connection: 'app',
        op: 'ui.fill',
      }),
      step.call({
        id: 'tap',
        connection: 'app',
        op: 'ui.tap',
      }),
    ],
    until: until.maxSteps(1),
  });
}

/** Runs once with `ui.tap` failing, leaving `ui.fill` recorded; returns the execution id. */
async function interrupted(
  storage: Storage,
  rig: Rig,
  provider: InMemoryConnectionProvider,
): Promise<string> {
  const harness = harnessFor(storage, provider);
  const ctx = harness.createContext();
  await harness.run(sequence(), '', ctx).catch(() => undefined);
  await harness.close();
  rig.failTap = false;
  return ctx.id;
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function rootKind(error: unknown): string | undefined {
  let current = error;
  while (isNoeticError(current) && current.noeticError.kind === 'step_failed') {
    current = current.noeticError.cause;
  }
  return isNoeticError(current) ? current.noeticError.kind : undefined;
}

function newRig(): Rig {
  return {
    calls: [],
    resets: [],
    failTap: true,
  };
}

//#endregion

describe('resuming against connections', () => {
  test('the same instance replays recorded calls', async () => {
    const rig = newRig();
    const storage = createInMemoryStorage();
    const id = await interrupted(storage, rig, app(rig, 'one', 'free'));
    const harness = harnessFor(storage, app(rig, 'one', 'free'));
    const ctx = await harness.restore(id);
    assert(ctx);
    rig.calls.length = 0;
    expect(await harness.run(sequence(), '', ctx)).toBe('tapped');
    expect(rig.calls).toEqual([
      'one:ui.tap',
    ]);
    await harness.close();
  });

  test("a replaced 'free' connection discards the ledger from its first use: ui.fill runs live again", async () => {
    const rig = newRig();
    const storage = createInMemoryStorage();
    const id = await interrupted(storage, rig, app(rig, 'one', 'free'));
    const harness = harnessFor(storage, app(rig, 'two', 'free'));
    const ctx = await harness.restore(id);
    assert(ctx);
    rig.calls.length = 0;
    expect(await harness.run(sequence(), '', ctx)).toBe('tapped');
    expect(rig.calls).toEqual([
      'two:ui.fill',
      'two:ui.tap',
    ]);
    expect(rig.resets).toEqual([]);
    await harness.close();
  });

  test("a replaced 'costly' connection is reset once before running live", async () => {
    const rig = newRig();
    const storage = createInMemoryStorage();
    const id = await interrupted(storage, rig, app(rig, 'one', 'costly'));
    const harness = harnessFor(storage, app(rig, 'two', 'costly'));
    const ctx = await harness.restore(id);
    assert(ctx);
    rig.calls.length = 0;
    await harness.run(sequence(), '', ctx);
    expect(rig.resets).toEqual([
      'two',
    ]);
    expect(rig.calls).toEqual([
      'two:ui.fill',
      'two:ui.tap',
    ]);
    await harness.close();
  });

  test('a replaced connection that declares no determinism is unsafe: refused, nothing sent', async () => {
    const rig = newRig();
    const storage = createInMemoryStorage();
    const id = await interrupted(storage, rig, app(rig, 'one', undefined));
    const harness = harnessFor(storage, app(rig, 'two', undefined));
    const ctx = await harness.restore(id);
    assert(ctx);
    rig.calls.length = 0;
    const e = await rejected(harness.run(sequence(), '', ctx));
    expect(rootKind(e)).toBe('connection_resume_refused');
    expect(rig.calls).toEqual([]);
    await harness.close();
  });

  test("harness.restore(id, { rerun }) lets a replaced 'unsafe' connection run live from the discarded point", async () => {
    const rig = newRig();
    const storage = createInMemoryStorage();
    const id = await interrupted(storage, rig, app(rig, 'one', 'unsafe'));
    const harness = harnessFor(storage, app(rig, 'two', 'unsafe'));
    const refused = await harness.restore(id);
    assert(refused);
    expect(rootKind(await rejected(harness.run(sequence(), '', refused)))).toBe(
      'connection_resume_refused',
    );
    const ctx = await harness.restore(id, {
      rerun: [
        'app',
      ],
    });
    assert(ctx);
    rig.calls.length = 0;
    expect(await harness.run(sequence(), '', ctx)).toBe('tapped');
    expect(rig.calls).toEqual([
      'two:ui.fill',
      'two:ui.tap',
    ]);
    await harness.close();
  });
});

describe('rerun allowances are scoped to the restored run', () => {
  test('a restore with rerun that never runs does not let a later plain restore drive the connection live', async () => {
    const rig = newRig();
    const storage = createInMemoryStorage();
    const id = await interrupted(storage, rig, app(rig, 'one', 'unsafe'));
    const harness = harnessFor(storage, app(rig, 'two', 'unsafe'));
    const unused = await harness.restore(id, {
      rerun: [
        'app',
      ],
    });
    assert(unused);
    expect(registryOf(harness)?.rerunAllowed(id, 'app')).toBe(false);
    const plain = await harness.restore(id);
    assert(plain);
    rig.calls.length = 0;
    expect(rootKind(await rejected(harness.run(sequence(), '', plain)))).toBe(
      'connection_resume_refused',
    );
    expect(rig.calls).toEqual([]);
    await harness.close();
  });

  test('a restore that finds nothing grants nothing', async () => {
    const rig = newRig();
    const storage = createInMemoryStorage();
    const harness = harnessFor(storage, app(rig, 'two', 'unsafe'));
    expect(
      await harness.restore('never-ran', {
        rerun: [
          'app',
        ],
      }),
    ).toBeNull();
    expect(registryOf(harness)?.rerunAllowed('never-ran', 'app')).toBe(false);
    await harness.close();
  });

  test('a run that fails before executing ends the allowance its restore granted', async () => {
    const rig = newRig();
    const storage = createInMemoryStorage();
    const id = await interrupted(storage, rig, app(rig, 'one', 'unsafe'));
    const harness = harnessFor(storage, app(rig, 'two', 'unsafe'));
    const ctx = await harness.restore(id, {
      rerun: [
        'app',
      ],
    });
    assert(ctx);
    // A root needing an operation the connection lacks fails negotiation before it executes.
    const unsatisfied = step.call({
      id: 'missing',
      connection: connection('app'),
      op: 'ui.missing',
    });
    const e = await rejected(harness.run(unsatisfied, '', ctx));
    assert(isNoeticConfigError(e));
    expect(e.code).toBe('CONNECTION_UNSATISFIED');
    rig.calls.length = 0;
    expect(rootKind(await rejected(harness.run(sequence(), '', ctx)))).toBe(
      'connection_resume_refused',
    );
    expect(rig.calls).toEqual([]);
    expect(registryOf(harness)?.rerunAllowed(id, 'app')).toBe(false);
    await harness.close();
  });

  test('the allowance holds while its run executes and ends with it', async () => {
    const rig = newRig();
    const storage = createInMemoryStorage();
    const id = await interrupted(storage, rig, app(rig, 'one', 'unsafe'));
    const harness = harnessFor(storage, app(rig, 'two', 'unsafe'));
    const ctx = await harness.restore(id, {
      rerun: [
        'app',
      ],
    });
    assert(ctx);
    let allowedDuring: boolean | undefined;
    const probed = loop({
      id: 'flow',
      steps: [
        step.call({
          id: 'fill',
          connection: 'app',
          op: 'ui.fill',
        }),
        step.call({
          id: 'tap',
          connection: 'app',
          op: 'ui.tap',
        }),
        runCode({
          id: 'probe',
          execute: async (input: unknown) => {
            allowedDuring = registryOf(harness)?.rerunAllowed(id, 'app');
            return input;
          },
        }),
      ],
      until: until.maxSteps(1),
    });
    rig.calls.length = 0;
    await harness.run(probed, '', ctx);
    expect(rig.calls).toEqual([
      'two:ui.fill',
      'two:ui.tap',
    ]);
    expect(allowedDuring).toBe(true);
    expect(registryOf(harness)?.rerunAllowed(id, 'app')).toBe(false);
    await harness.close();
  });
});

describe('resuming a long operation', () => {
  test('a call whose task already started waits on that task instead of sending again', async () => {
    let sent = 0;
    const provider = createInMemoryConnection({
      instance: 'device',
      operations: {
        'device.install': {
          task: [
            {
              state: 'working',
            },
          ],
          run: () => {
            sent += 1;
            return 'installed';
          },
        },
      },
    });
    const storage = createInMemoryStorage();
    const harness = harnessFor(storage, provider);
    const resolved = await registryOf(harness)?.resolve({
      name: 'app',
      scope: {
        executionId: 'exec',
        threadId: 't',
        scopeKey: 'exec',
        signal: new AbortController().signal,
      },
    });
    assert(resolved?.awaitTask);
    const started = await provider.connection.call(
      'device.install',
      {},
      {
        signal: new AbortController().signal,
        idempotencyKey: 'k',
      },
    );
    assert(started.status === 'task');
    const output = await resolved.awaitTask(started.taskId, 'device.install', {
      signal: new AbortController().signal,
      caller: 'step',
      idempotencyKey: 'k',
    });
    expect(output).toBe('installed');
    expect(provider.connection.calls).toHaveLength(1);
    expect(sent).toBe(1);
    await harness.close();
  });
});
