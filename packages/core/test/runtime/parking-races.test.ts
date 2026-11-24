// Parked turns under real conditions: storage that takes time, turns that took more
// than one message, flows that catch what a wait throws. Each of these lost or
// stranded a parked turn before. See specs/23-durable-execution § Parked turns.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { CallModelRequest, ContextData, LLMResponse } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel, invokeTool, runCode, step } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { defineSource } from '../../src/connections/sources';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { assistantMessage, slowStorage } from '../_helpers';

//#region Fixtures

const DAY = 864e5;
const THREAD = {
  threadId: 't',
};

async function tick(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 2e3; i += 1) {
    if (await done()) {
      return;
    }
    await tick(1);
  }
  assert(await done());
}

interface Model {
  calls: number;
  /** Resolve to let the first call return; later calls return at once. */
  release: () => void;
  call: (request: CallModelRequest) => Promise<LLMResponse>;
}

/** Answers `<tag>-<n>`. With `gated`, its first call waits for `release()`. */
function model(tag: string, gated = false): Model {
  let release: () => void = () => {};
  const gate = gated
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  const m: Model = {
    calls: 0,
    release: () => release(),
    call: async () => {
      m.calls += 1;
      if (m.calls === 1) {
        await gate;
      }
      return {
        items: [
          assistantMessage(`${tag}-${m.calls}`),
        ],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
        },
      };
    },
  };
  return m;
}

type Mailbox = string[];

/** A source over `mailbox` that replays from a cursor: the index of the last reply seen. */
function inbox(mailbox: Mailbox) {
  return defineSource({
    events: {
      reply: z.object({
        text: z.string(),
      }),
    },
    async start({ emit, cursor, signal }) {
      let next = cursor === null ? 0 : Number(cursor) + 1;
      while (!signal.aborted) {
        const text = mailbox[next];
        if (text === undefined) {
          await tick(2);
          continue;
        }
        await emit({
          type: 'reply',
          id: `reply-${next}`,
          cursor: String(next),
          payload: {
            text,
          },
        });
        next += 1;
      }
    },
  });
}

const WaitedSchema = z.object({
  event: z.object({
    payload: z.object({
      text: z.string(),
    }),
  }),
});

const answer = callModel<ContextData, string, string>({
  id: 'answer',
  model: 'test/model',
});

interface Rig {
  storage: StorageAdapter;
  mailbox: Mailbox;
  m: Model;
  /** What a flow does with the wait. Default: wait a day for a reply, then answer with it. */
  body?: 'answer' | 'catch';
  filter?: () => Promise<boolean>;
  graceMs?: number;
}

function harnessOn(rig: Rig): AgentHarness {
  const wait = step.wait({
    id: 'wait',
    connection: 'inbox',
    event: 'reply',
    timeoutMs: DAY,
    ...(rig.filter
      ? {
          filter: rig.filter,
        }
      : {}),
  });
  const flow = runCode<ContextData, string, string>({
    id: 'flow',
    execute: async (_input, execCtx) => {
      if (rig.body === 'catch') {
        try {
          await execCtx.harness.run(wait, undefined, execCtx);
        } catch {
          return 'nobody replied in a day';
        }
        return 'replied';
      }
      const waited = WaitedSchema.parse(await execCtx.harness.run(wait, undefined, execCtx));
      return String(await execCtx.harness.run(answer, waited.event.payload.text, execCtx));
    },
  });
  return new AgentHarness({
    name: 'races',
    params: {},
    agentGraph: flow,
    connections: {
      inbox: inbox(rig.mailbox),
    },
    environment: {
      storage: {
        adapter: rig.storage,
        lease: {
          waitMs: 0,
        },
        park: {
          graceMs: rig.graceMs ?? 0,
          autoWake: false,
        },
      },
    },
    _testCallModel: (request) => rig.m.call(request),
  });
}

interface StoredTurn {
  turn?: {
    executionId: string;
    messageIds: string[];
    parked?: object;
  };
}

function storedTurn(storage: StorageAdapter): Promise<StoredTurn['turn']> {
  return storage.get<StoredTurn>('session:t').then((record) => record?.turn);
}

//#endregion

describe('a parked turn that took more than one message', () => {
  it('is resumed by wake() as the one turn it was', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const mailbox: Mailbox = [
      'first',
    ];
    // Turn 1 runs while two more messages queue; turn 2 takes both and parks.
    const a = model('a', true);
    const first = harnessOn({
      storage,
      mailbox,
      m: a,
    });
    await first.execute('one', {
      ...THREAD,
      messageId: 'm-0',
    });
    await until(() => a.calls === 1);
    await first.execute('two', {
      ...THREAD,
      messageId: 'm-1',
    });
    await first.execute('three', {
      ...THREAD,
      messageId: 'm-2',
    });
    a.release();
    await until(async () => (await storedTurn(storage))?.parked !== undefined);
    const parked = await storedTurn(storage);
    assert(parked);
    expect(parked.messageIds).toEqual([
      'm-1',
      'm-2',
    ]);
    await first.close();

    const b = model('b');
    const second = harnessOn({
      storage,
      mailbox,
      m: b,
    });
    mailbox.push('second');
    expect(await second.wake(THREAD)).toEqual([
      't',
    ]);
    const response = await second.getAgentResponse(THREAD);
    expect(response.text).toBe('b-1');
    // One model call, for the one turn: not two fresh turns with nothing to say.
    expect(b.calls).toBe(1);
    expect(await storedTurn(storage)).toBeUndefined();
    await second.close();
  });
});

describe('a message that arrives while a turn is closing out its park', () => {
  it('waits behind the parked turn instead of replacing it', async () => {
    const base = createInMemoryStorage({
      swap: true,
    });
    const m = model('a');
    const harness = harnessOn({
      storage: slowStorage(base, 5),
      mailbox: [],
      m,
    });
    await harness.execute('hello', {
      ...THREAD,
      messageId: 'm-1',
    });
    // The record says parked before the runner has finished closing the turn out.
    await until(async () => (await storedTurn(base))?.parked !== undefined);
    const parked = await storedTurn(base);
    assert(parked);
    await harness.execute('follow-up', {
      ...THREAD,
      messageId: 'm-2',
    });
    await tick(150);

    const after = await storedTurn(base);
    assert(after);
    expect(after.executionId).toBe(parked.executionId);
    expect(after.messageIds).toEqual([
      'm-1',
    ]);
    expect(after.parked).toBeDefined();
    await harness.close();
  });
});

describe('a flow that catches what its wait throws', () => {
  it('is still parked, in storage as well as in the response', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const harness = harnessOn({
      storage,
      mailbox: [],
      m: model('a'),
      body: 'catch',
    });
    await harness.execute('hello', {
      ...THREAD,
      messageId: 'm-1',
    });
    const response = await harness.getAgentResponse(THREAD);
    assert(response.parked);
    expect(response.text).toBe('');
    expect((await storedTurn(storage))?.parked).toBeDefined();
    expect(await harness.getNextWakeTime()).toBeDefined();
    await harness.close();
  });
});

describe('a wait whose filter takes longer than the grace', () => {
  it('lets the filter finish and delivers the event', async () => {
    let filterRuns = 0;
    const harness = harnessOn({
      storage: createInMemoryStorage({
        swap: true,
      }),
      mailbox: [
        'the reply',
      ],
      m: model('a'),
      graceMs: 20,
      filter: async () => {
        filterRuns += 1;
        await tick(80);
        return true;
      },
    });
    await harness.execute('hello', {
      ...THREAD,
      messageId: 'm-1',
    });
    const response = await harness.getAgentResponse(THREAD);
    expect(response.parked).toBeUndefined();
    expect(response.text).toBe('a-1');
    expect(filterRuns).toBe(1);
    await harness.close();
  });
});

describe('abort() on a thread whose turn is parked', () => {
  it('drops the turn, so a later wake finds nothing', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const rig = {
      storage,
      mailbox: [],
      m: model('a'),
    };
    const first = harnessOn(rig);
    await first.execute('hello', {
      ...THREAD,
      messageId: 'm-1',
    });
    assert((await first.getAgentResponse(THREAD)).parked);
    await first.close();

    // Another harness, which never ran the thread, is the one asked to abort it.
    const second = harnessOn(rig);
    await second.abort(THREAD);
    expect(await storedTurn(storage)).toBeUndefined();
    expect(await second.wake(THREAD)).toEqual([]);
    // Its checkpoint and ledger go; the trail of what it did is kept.
    const left = await storage.list('execution:');
    expect(left.filter((key) => !key.includes(':trail:'))).toEqual([]);
    await second.close();
  });
});

describe('an answer that lands while the turn is parking', () => {
  it('still finishes the turn, however the two are timed', async () => {
    for (const delay of [
      0,
      15,
      40,
      90,
    ]) {
      const base = createInMemoryStorage({
        swap: true,
      });
      const runs: number[] = [];
      const pay = invokeTool({
        id: 'pay',
        tool: tool({
          name: 'pay',
          description: 'Pay.',
          input: z.object({
            amount: z.number(),
          }),
          output: z.string(),
          needsApproval: true,
          execute: async ({ amount }) => {
            runs.push(amount);
            return `paid ${amount}`;
          },
        }),
      });
      const harness = new AgentHarness({
        name: 'races',
        params: {},
        agentGraph: runCode<ContextData, string, string>({
          id: 'flow',
          execute: async (_input, execCtx) =>
            String(
              await execCtx.harness.run(
                pay,
                {
                  amount: 5,
                },
                execCtx,
              ),
            ),
        }),
        environment: {
          storage: {
            adapter: slowStorage(base, 10),
            lease: {
              waitMs: 0,
            },
            park: {
              graceMs: 0,
              autoWake: false,
            },
          },
        },
      });
      await harness.execute('go', {
        ...THREAD,
        messageId: 'm-1',
      });
      let callId: string | undefined;
      await until(async () => {
        callId = (await harness.pending(THREAD))[0]?.callId;
        return callId !== undefined;
      });
      assert(callId);
      await tick(delay);
      await harness.execute(
        {
          type: 'noetic:decision',
          callId,
          action: 'allow',
        },
        THREAD,
      );
      await until(() => runs.length === 1);
      await until(async () => (await storedTurn(base)) === undefined);
      expect(runs).toEqual([
        5,
      ]);
      await harness.close();
    }
  });
});
