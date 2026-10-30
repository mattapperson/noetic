// Pending ledger entries for connection steps (spec 23a § Connection Steps,
// spec 35 § Durability): written before a call or wait reaches a server,
// cleared once it has a result, and reconciled on resume against the
// connection's identity and determinism.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { Determinism } from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import { step } from '../../src/builders/step-builders';
import type { ConnectionScope } from '../../src/connections/registry-types';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { PendingEntry, StepConnection } from '../../src/interpreter/connection-steps';
import {
  clearPendingEntries,
  idempotencyKeyFor,
  PendingEntries,
  pendingEntryKey,
  reconcilePending,
  scopeFor,
} from '../../src/interpreter/connection-steps';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { setHarnessInternals } from '../../src/util/harness-internals';
import type { FakeConnectionConfig } from './_helpers';
import { FakeRegistry } from './_helpers';

//#region Helpers

type Storage = ReturnType<typeof createInMemoryStorage>;

function determinism(replayPrefix: Determinism['replayPrefix']): Determinism {
  return {
    reset: 'cheap',
    replayPrefix,
    time: 'wall',
    observation: 'exact',
    actions: 'reversible',
  };
}

const SCOPE: ConnectionScope = {
  executionId: 'run-1',
  threadId: 't',
  scopeKey: 'run-1',
  signal: new AbortController().signal,
};

async function stepConnection(
  config: FakeConnectionConfig,
  storage: Storage,
): Promise<{
  connection: StepConnection;
  registry: FakeRegistry;
}> {
  const registry = new FakeRegistry({
    app: config,
  });
  const resolved = await registry.resolve({
    name: 'app',
    scope: SCOPE,
  });
  return {
    registry,
    connection: {
      resolved,
      scope: SCOPE,
      idempotencyKey: 'run-1:/tap#0',
      pending: new PendingEntries(storage, pendingEntryKey('run-1', '/tap#0')),
    },
  };
}

function entry(instance: string): PendingEntry {
  return {
    stepId: 'tap',
    kind: 'call',
    connection: 'app',
    key: 'run-1:/tap#0',
    identity: {
      surface: 'fake',
      instance,
    },
  };
}

function durableHarness(storage: Storage, registry: FakeRegistry): AgentHarness {
  const harness = new AgentHarness({
    name: 'pending-test',
    params: {},
    environment: {
      storage: {
        adapter: storage,
        checkpointStore: createCheckpointStore({
          storage,
        }),
      },
    },
  });
  setHarnessInternals(harness, {
    connectionRegistry: registry,
  });
  return harness;
}

//#endregion

describe('PendingEntries', () => {
  it('round-trips an entry and ignores one that does not parse', async () => {
    const storage = createInMemoryStorage();
    const pending = new PendingEntries(storage, 'k');
    expect(await pending.load()).toBeUndefined();
    await pending.write(entry('a'));
    expect(await pending.load()).toEqual(entry('a'));
    await storage.set('k', {
      nonsense: true,
    });
    expect(await pending.load()).toBeUndefined();
    await pending.clear();
    expect(await storage.get('k')).toBeNull();
  });
});

describe('reconcilePending', () => {
  it('returns nothing when no attempt left an entry', async () => {
    const { connection } = await stepConnection({}, createInMemoryStorage());
    expect(await reconcilePending(connection, SCOPE.signal)).toBeUndefined();
  });

  it('picks up the entry against the same identity', async () => {
    const storage = createInMemoryStorage();
    const { connection } = await stepConnection({}, storage);
    await connection.pending?.write(entry('app-1'));
    expect(await reconcilePending(connection, SCOPE.signal)).toEqual(entry('app-1'));
  });

  it("runs live against a replaced 'free' connection, discarding the entry", async () => {
    const storage = createInMemoryStorage();
    const { connection } = await stepConnection(
      {
        determinism: determinism('free'),
      },
      storage,
    );
    await connection.pending?.write(entry('old'));
    expect(await reconcilePending(connection, SCOPE.signal)).toBeUndefined();
    expect(await connection.pending?.load()).toBeUndefined();
  });

  it("resets a replaced 'costly' connection before running live", async () => {
    const storage = createInMemoryStorage();
    let reset = 0;
    const { connection, registry } = await stepConnection(
      {
        determinism: determinism('costly'),
        onReset: () => {
          reset += 1;
        },
      },
      storage,
    );
    await connection.pending?.write(entry('old'));
    expect(await reconcilePending(connection, SCOPE.signal)).toBeUndefined();
    expect(reset).toBe(1);
    expect(registry.resets).toEqual([
      'app',
    ]);
  });

  it('treats a replaced connection that declares no determinism as unsafe', async () => {
    const storage = createInMemoryStorage();
    const { connection } = await stepConnection({}, storage);
    await connection.pending?.write(entry('old'));
    try {
      await reconcilePending(connection, SCOPE.signal);
      expect.unreachable('expected connection_resume_refused');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('connection_resume_refused');
    }
  });

  it("refuses a replaced 'costly' connection that cannot reset", async () => {
    const storage = createInMemoryStorage();
    const { connection } = await stepConnection(
      {
        determinism: determinism('costly'),
      },
      storage,
    );
    await connection.pending?.write(entry('old'));
    try {
      await reconcilePending(connection, SCOPE.signal);
      expect.unreachable('expected connection_resume_refused');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('connection_resume_refused');
    }
  });

  it("refuses a replaced 'unsafe' connection with connection_resume_refused", async () => {
    const storage = createInMemoryStorage();
    const { connection } = await stepConnection(
      {
        determinism: determinism('unsafe'),
      },
      storage,
    );
    await connection.pending?.write(entry('old'));
    try {
      await reconcilePending(connection, SCOPE.signal);
      expect.unreachable('expected connection_resume_refused');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('connection_resume_refused');
      assert(e.noeticError.kind === 'connection_resume_refused');
      expect(e.noeticError.connection).toBe('app');
    }
  });
});

describe('scopes and keys', () => {
  it('scopes run leases to the run root and path leases to the path context', () => {
    const harness = new AgentHarness({
      name: 'scope-test',
      params: {},
    });
    const root = harness.createContext();
    const child = harness.createContext({
      parent: root,
    });
    expect(scopeFor(child, 'run').scopeKey).toBe(root.id);
    expect(scopeFor(child, 'path').scopeKey).toBe(`${root.id}:path:${child.id}`);
    expect(scopeFor(child, undefined).executionId).toBe(root.id);
    expect(idempotencyKeyFor(child, 'tap', 'key:abc')).toBe(`${root.id}:key:abc`);
    expect(idempotencyKeyFor(child, 'tap')).toBe(`${root.id}:tap`);
  });
});

describe('durable call steps', () => {
  it('write a pending entry before the server sees the call and clear it after', async () => {
    const storage = createInMemoryStorage();
    const seen: Array<unknown[]> = [];
    const registry = new FakeRegistry({
      app: {
        ops: {
          'ui.tap': async () => {
            const keys = await storage.list('execution:');
            seen.push(keys.filter((k) => k.includes(':pending:')));
            return {
              ok: true,
            };
          },
        },
      },
    });
    const harness = durableHarness(storage, registry);
    const ctx = harness.createContext();
    await harness.run(
      step.call({
        id: 'tap',
        connection: 'app',
        op: 'ui.tap',
      }),
      '',
      ctx,
    );
    expect(seen[0]).toHaveLength(1);
    const pendingKeys = (await storage.list('execution:')).filter((k) => k.includes(':pending:'));
    expect(pendingKeys).toEqual([]);
  });

  it('re-sends with the recorded key when a previous attempt left a pending entry', async () => {
    const storage = createInMemoryStorage();
    const registry = new FakeRegistry({
      app: {},
    });
    const harness = durableHarness(storage, registry);
    const ctx = harness.createContext();
    const call = step.call({
      id: 'tap',
      connection: 'app',
      op: 'ui.tap',
    });
    const ledgerKey = '/tap#0';
    await storage.set(pendingEntryKey(ctx.id, ledgerKey), {
      ...entry('app-1'),
      key: 'earlier-key',
    });
    await harness.run(call, '', ctx);
    expect(registry.calls[0]?.opts.idempotencyKey).toBe('earlier-key');
  });

  it('waits on the recorded task instead of sending the operation again', async () => {
    const storage = createInMemoryStorage();
    const registry = new FakeRegistry({
      app: {},
    });
    const harness = durableHarness(storage, registry);
    const ctx = harness.createContext();
    await storage.set(pendingEntryKey(ctx.id, '/tap#0'), {
      ...entry('app-1'),
      taskId: 'task-7',
    });
    const output = await harness.run(
      step.call({
        id: 'tap',
        connection: 'app',
        op: 'ui.tap',
      }),
      '',
      ctx,
    );
    expect(output).toEqual({
      resumedTask: 'task-7',
    });
    expect(registry.awaited).toEqual([
      'task-7',
    ]);
    expect(registry.calls).toEqual([]);
  });
});

describe('clearPendingEntries', () => {
  it("deletes every pending entry of one run and leaves other runs' and other keys alone", async () => {
    const storage = createInMemoryStorage();
    await storage.set(pendingEntryKey('run-1', 'a'), {
      x: 1,
    });
    await storage.set(pendingEntryKey('run-1', 'b'), {
      x: 2,
    });
    await storage.set(pendingEntryKey('run-10', 'a'), {
      x: 3,
    });
    await storage.set('execution:run-1:ledger', {
      kept: true,
    });
    await clearPendingEntries(storage, 'run-1');
    expect(await storage.list('execution:run-1:pending:')).toEqual([]);
    expect(await storage.get(pendingEntryKey('run-10', 'a'))).toEqual({
      x: 3,
    });
    expect(await storage.get('execution:run-1:ledger')).toEqual({
      kept: true,
    });
  });
});
