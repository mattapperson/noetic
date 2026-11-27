import { describe, expect, test } from 'bun:test';
import type { ConnectionTrigger } from '@noetic-tools/types';
import { z } from 'zod';
import { createConnectionRuntime } from '../../src/connections/registry';
import { defineSource } from '../../src/connections/sources';
import type { TriggerDelivery } from '../../src/connections/triggers';
import { TriggerRunner } from '../../src/connections/triggers';
import { AgentHarness, createInMemoryStorage, runCode } from '../../src/index';
import { createInMemoryArtifactStore } from '../../src/runtime/in-memory-artifact-store';

const events = {
  received: z.object({
    folder: z.string(),
  }),
};
const trigger: ConnectionTrigger = {
  id: 'inbox',
  connection: 'mail',
  event: 'received',
  filter: 'event.payload.folder = "inbox"',
  input: 'event.id',
};

function mail(
  id: string,
  folder = 'inbox',
): {
  id: string;
  type: 'received';
  payload: {
    folder: string;
  };
} {
  return {
    id,
    type: 'received',
    payload: {
      folder,
    },
  };
}

async function rig(options: {
  storage?: ReturnType<typeof createInMemoryStorage>;
  deliver?: (delivery: TriggerDelivery) => Promise<void>;
}) {
  const storage = options.storage ?? createInMemoryStorage();
  const source = defineSource({
    events,
  });
  const runtime = createConnectionRuntime({
    connections: {
      mail: source,
    },
    storage,
    artifacts: createInMemoryArtifactStore(),
  });
  const delivered: TriggerDelivery[] = [];
  const runner = new TriggerRunner({
    runtime,
    storage,
    triggers: [
      trigger,
    ],
    deliver:
      options.deliver ??
      (async (delivery) => {
        delivered.push(delivery);
      }),
    redeliverDelayMs: () => 0,
    onError: () => {},
  });
  await runtime.start();
  await runner.start();
  return {
    source,
    runner,
    delivered,
    close: async () => {
      await runner.close();
      await runtime.close();
    },
  };
}

describe('trigger outcomes', () => {
  test('a concurrent duplicate and a resend after restart start one workflow run', async () => {
    const storage = createInMemoryStorage();
    let calls = 0;
    const make = () => {
      const source = defineSource({
        events,
      });
      const harness = new AgentHarness({
        name: 'mail-workflow',
        params: {},
        connections: {
          mail: source,
        },
        triggerTurnOn: [
          trigger,
        ],
        environment: {
          storage: {
            adapter: storage,
          },
        },
        agentGraph: runCode({
          id: 'run',
          execute: async () => {
            calls++;
            return 'done';
          },
        }),
      });
      return {
        source,
        harness,
      };
    };
    const set = storage.set.bind(storage);
    let cut = true;
    storage.set = async (key, value) => {
      if (cut && key.includes('/seen/')) {
        throw new Error('stopped after the workflow finished, before recording delivery');
      }
      await set(key, value);
    };
    const first = make();
    await first.harness.start();
    await Promise.all([
      first.source.emit(mail('message-1')),
      first.source.emit(mail('message-1')),
    ]);
    await first.harness.waitForIdle();
    expect(calls).toBe(1);
    expect(await first.harness.getTriggerOutcomes(trigger.id)).toMatchObject([
      {
        eventId: 'message-1',
        status: 'pending',
      },
    ]);
    await first.harness.close();

    cut = false;
    const restarted = make();
    await restarted.harness.start();
    await restarted.source.emit(mail('message-1'));
    await restarted.harness.waitForIdle();
    expect(calls).toBe(1);
    expect(await restarted.harness.getTriggerOutcomes(trigger.id)).toMatchObject([
      {
        eventId: 'message-1',
        status: 'delivered',
      },
    ]);
    await restarted.harness.close();
  });

  test('wake delivers an event whose receipt was not written', async () => {
    const storage = createInMemoryStorage();
    const source = defineSource({
      events,
    });
    let calls = 0;
    const harness = new AgentHarness({
      name: 'mail-workflow',
      params: {},
      connections: {
        mail: source,
      },
      triggerTurnOn: [
        trigger,
      ],
      environment: {
        storage: {
          adapter: storage,
        },
      },
      agentGraph: runCode({
        id: 'run',
        execute: async () => {
          calls++;
          return 'done';
        },
      }),
    });
    const set = storage.set.bind(storage);
    let cut = true;
    storage.set = async (key, value) => {
      if (cut && key.includes('/seen/')) {
        throw new Error('the store is down');
      }
      await set(key, value);
    };
    await harness.start();
    await source.emit(mail('message-1'));
    await harness.waitForIdle();
    expect(await harness.getTriggerOutcomes(trigger.id)).toMatchObject([
      {
        status: 'pending',
      },
    ]);
    cut = false;
    await harness.wake();
    await harness.waitForIdle();
    expect(await harness.getTriggerOutcomes(trigger.id)).toMatchObject([
      {
        eventId: 'message-1',
        status: 'delivered',
      },
    ]);
    expect(calls).toBe(1);
    expect(await harness.replayTriggerEvent(trigger.id, 'message-1')).toBe(false);
    expect(await harness.replayTriggerEvent('no-such-trigger', 'message-1')).toBe(false);
    await harness.close();
  });

  test('keeps no record of an event its filter turns away', async () => {
    const { source, runner, delivered, close } = await rig({});
    await source.emit(mail('spam', 'junk'));
    await runner.idle();
    expect(delivered).toEqual([]);
    expect(await runner.outcomes(trigger.id)).toEqual([]);
    expect(await runner.outcomes('unknown')).toEqual([]);
    await close();
  });

  test('a trigger removed while it is being added does not listen', async () => {
    const storage = createInMemoryStorage();
    const list = storage.list.bind(storage);
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    storage.list = async (path) => {
      if (path.includes('/triggers/late/inbox/')) {
        paused.resolve();
        await release.promise;
      }
      return list(path);
    };
    const { source, runner, delivered, close } = await rig({
      storage,
    });
    const adding = runner.add({
      ...trigger,
      id: 'late',
    });
    await paused.promise;
    const removing = runner.remove('late');
    release.resolve();
    await adding;
    expect(await removing).toBe(true);
    await source.emit(mail('one'));
    await runner.idle();
    expect(delivered.map((delivery) => delivery.trigger)).toEqual([
      trigger.id,
    ]);
    expect(await list('noetic/connections/triggers/late/')).toEqual([]);
    await close();
  });

  test('waits for removal before reusing a trigger id', async () => {
    const storage = createInMemoryStorage();
    const drop = storage.delete.bind(storage);
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    storage.delete = async (key) => {
      if (key.endsWith('/triggers-added/inbox')) {
        paused.resolve();
        await release.promise;
      }
      await drop(key);
    };
    const { source, runner, close } = await rig({
      storage,
    });
    const removing = runner.remove(trigger.id);
    await paused.promise;
    await expect(runner.add(trigger)).rejects.toThrow('is being removed');
    release.resolve();
    await removing;
    await runner.add(trigger);
    await source.emit(mail('one'));
    // The new listener attaches after `add` resolves; the source holds the event for it.
    while ((await runner.outcomes(trigger.id))[0]?.status !== 'delivered') {
      await Bun.sleep(1);
    }
    expect(await runner.outcomes(trigger.id)).toMatchObject([
      {
        status: 'delivered',
      },
    ]);
    await close();
  });

  test('a trigger added again is not held up by a turn of the one it replaced', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runs: string[] = [];
    const { source, runner, close } = await rig({
      deliver: async (delivery) => {
        runs.push(delivery.event.id);
        if (runs.length === 1) {
          started.resolve();
          await release.promise;
        }
      },
    });
    await source.emit(mail('e'));
    await started.promise;
    expect(await runner.remove(trigger.id)).toBe(true);
    await runner.add({
      ...trigger,
    });
    // The new listener attaches after `add` resolves; the source holds the event for it.
    await source.emit(mail('e'));
    while ((await runner.outcomes(trigger.id)).length === 0) {
      await Bun.sleep(1);
    }
    release.resolve();
    await runner.idle();
    expect(runs).toEqual([
      'e',
      'e',
    ]);
    expect(await runner.outcomes(trigger.id)).toMatchObject([
      {
        eventId: 'e',
        status: 'delivered',
      },
    ]);
    await close();
  });

  test('replay keeps the event and message ids, across a restart, and runs once', async () => {
    const storage = createInMemoryStorage();
    const ids = new Set<string>();
    let tries = 0;
    let failing = true;
    const options = {
      storage,
      deliver: async (delivery: TriggerDelivery) => {
        ids.add(delivery.messageId);
        tries++;
        if (failing) {
          throw new Error('workflow unavailable');
        }
      },
    };
    const first = await rig(options);
    await first.source.emit(mail('e'));
    await first.runner.idle();
    expect(tries).toBe(5);
    expect(await first.runner.outcomes(trigger.id)).toMatchObject([
      {
        eventId: 'e',
        status: 'failed',
        attempts: 5,
      },
    ]);
    await first.close();

    failing = false;
    const restarted = await rig(options);
    await restarted.runner.idle();
    expect(tries).toBe(5);
    expect(await restarted.runner.replay(trigger.id, 'never-seen')).toBe(false);
    expect(await restarted.runner.replay('no-such-trigger', 'e')).toBe(false);
    const replay = await Promise.all([
      restarted.runner.replay(trigger.id, 'e'),
      restarted.runner.replay(trigger.id, 'e'),
    ]);
    expect(replay.filter(Boolean)).toHaveLength(1);
    await restarted.runner.idle();
    expect(tries).toBe(6);
    expect(ids.size).toBe(1);
    expect(await restarted.runner.replay(trigger.id, 'e')).toBe(false);
    await restarted.close();
  });

  test('a replay the store fails rejects, and the event can be replayed again', async () => {
    const storage = createInMemoryStorage();
    let failing = true;
    const { source, runner, close } = await rig({
      storage,
      deliver: async () => {
        if (failing) {
          throw new Error('workflow unavailable');
        }
      },
    });
    await source.emit(mail('e'));
    await runner.idle();
    failing = false;
    const set = storage.set.bind(storage);
    storage.set = async () => {
      throw new Error('the store is down');
    };
    await expect(runner.replay(trigger.id, 'e')).rejects.toThrow('the store is down');
    storage.set = set;
    expect(await runner.replay(trigger.id, 'e')).toBe(true);
    await runner.idle();
    expect(await runner.outcomes(trigger.id)).toMatchObject([
      {
        eventId: 'e',
        status: 'delivered',
      },
    ]);
    await close();
  });
});
