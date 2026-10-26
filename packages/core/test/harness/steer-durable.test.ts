// Steers on a durable thread: a turn cut off before it applied a steer resumes on a new
// harness and applies it there; a steer the cut-off run already applied comes back with
// the replayed rounds and is not applied twice. Drives the real model client against a
// fake server.

import { afterEach, describe, expect, it } from 'bun:test';
import type { StorageAdapter } from '@noetic-tools/context';
import type { ContextData } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createSessionStore } from '../../src/runtime/durable/session-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { FakeOpenRouter } from '../_helpers';
import { startFakeOpenRouter } from '../_helpers';

//#region Fixtures

const LOOKUPS = 3;
const STEER = 'use the staging database';

/** Asks for `lookup` once per round until it has seen LOOKUPS results, then answers. */
function lookingModel(input: unknown[]): unknown[] {
  const done = input.filter(
    (entry) =>
      z
        .object({
          type: z.literal('function_call_output'),
        })
        .safeParse(entry).success,
  ).length;
  if (done < LOOKUPS) {
    return [
      {
        type: 'function_call',
        id: `fc_${done}`,
        call_id: `call_${done}`,
        name: 'lookup',
        arguments: JSON.stringify({
          n: done + 1,
        }),
        status: 'completed',
      },
    ];
  }
  return [
    {
      type: 'message',
      id: 'msg_done',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'done',
          annotations: [],
        },
      ],
    },
  ];
}

const servers: FakeOpenRouter[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

/**
 * A harness on `storage`. With `sendSteer`, its `lookup` tool sends a steer into the
 * turn on its first run — the way a user types while the agent works.
 */
function harnessOver(
  storage: StorageAdapter,
  server: FakeOpenRouter,
  sendSteer: boolean,
): AgentHarness {
  let steered = !sendSteer;
  const lookup = tool({
    name: 'lookup',
    description: 'Look something up.',
    input: z.object({
      n: z.number(),
    }),
    output: z.object({
      ok: z.boolean(),
    }),
    execute: async () => {
      if (!steered) {
        steered = true;
        await harness.execute(STEER, {
          threadId: 't',
          messageId: 'steer-1',
          deliveryMode: 'between-rounds',
        });
      }
      return {
        ok: true,
      };
    },
  });
  const harness = new AgentHarness({
    name: 'durable-steer',
    params: {},
    agentGraph: callModel<ContextData, string, string>({
      id: 'agent',
      model: 'test/model',
      tools: [
        lookup,
      ],
    }),
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: server.baseUrl,
    },
    environment: {
      storage: {
        adapter: storage,
      },
    },
  });
  return harness;
}

function startServer(): FakeOpenRouter {
  const server = startFakeOpenRouter(lookingModel);
  servers.push(server);
  return server;
}

function steerCount(server: FakeOpenRouter, round: number): number {
  return JSON.stringify(server.rounds[round]?.input ?? []).split(STEER).length - 1;
}

async function runCutOff(storage: StorageAdapter, server: FakeOpenRouter): Promise<void> {
  const first = harnessOver(storage, server, true);
  await first.execute('go', {
    threadId: 't',
    messageId: 'm-1',
  });
  await expect(
    first.getAgentResponse({
      threadId: 't',
    }),
  ).rejects.toThrow();
}

async function resume(storage: StorageAdapter, server: FakeOpenRouter): Promise<string> {
  const next = harnessOver(storage, server, false);
  await next.execute('go', {
    threadId: 't',
    messageId: 'm-1',
  });
  const response = await next.getAgentResponse({
    threadId: 't',
  });
  return response.text;
}

//#endregion

describe('durable steers', () => {
  it('a steer the cut-off run never recorded is applied by the resumed turn', async () => {
    const server = startServer();
    // Round 1 (request 2) carries the steer and drops, so no record of it lands.
    server.dropAt.add(2);
    const storage = createInMemoryStorage();
    await runCutOff(storage, server);
    const kept = await createSessionStore(storage).load('t');
    expect(kept?.steers?.map((steer) => steer.id)).toEqual([
      'steer-1',
    ]);

    expect(await resume(storage, server)).toBe('done');

    // Request 3 is the resumed round 1: round 0 replayed, the steer applied again.
    expect(steerCount(server, 2)).toBe(1);
    expect(steerCount(server, 3)).toBe(1);
    expect((await createSessionStore(storage).load('t'))?.steers ?? []).toEqual([]);
  });

  it('a steer in a recorded round is replayed, not applied twice', async () => {
    const server = startServer();
    // Round 1 applies the steer, runs its tool, and records; round 2 drops.
    server.dropAt.add(3);
    const storage = createInMemoryStorage();
    await runCutOff(storage, server);

    expect(await resume(storage, server)).toBe('done');

    // Request 4 is the resumed round 2, built on the replayed rounds.
    expect(steerCount(server, 3)).toBe(1);
    expect(server.rounds[3]?.input).toEqual(server.rounds[2]?.input);
    expect((await createSessionStore(storage).load('t'))?.steers ?? []).toEqual([]);
  });

  it('keeps no steers once the turn finishes', async () => {
    const server = startServer();
    const storage = createInMemoryStorage();
    const harness = harnessOver(storage, server, true);
    await harness.execute('go', {
      threadId: 't',
      messageId: 'm-1',
    });
    expect(
      (
        await harness.getAgentResponse({
          threadId: 't',
        })
      ).text,
    ).toBe('done');
    expect(steerCount(server, 1)).toBe(1);
    expect((await createSessionStore(storage).load('t'))?.steers ?? []).toEqual([]);
  });
});
