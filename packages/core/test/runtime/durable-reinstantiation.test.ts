// Durable execution across harness instances: a run cut off on one harness resumes on a
// new harness built over the same storage. See specs/23a-step-level-resume.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type {
  CallModelRequest,
  Context,
  ContextData,
  Item,
  LLMResponse,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { inParallel } from '../../src/builders/control-flow-builders';
import { loop } from '../../src/builders/loop-builder';
import { callModel, runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createStepLedgerStore } from '../../src/runtime/durable/step-ledger';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { until } from '../../src/until/predicates';
import { assistantMessage } from '../_helpers';

//#region Fixtures

/**
 * A model whose every answer is new (`<tag>-<n>`), so a replayed answer is told apart
 * from a fresh one, and which drops the connection on the calls in `failAt`. It keeps
 * the transcript each call was sent, so tests can compare what the model saw.
 */
interface Model {
  calls: number;
  seen: string[][];
  call: (request: CallModelRequest) => Promise<LLMResponse>;
}

function model(tag: string, failAt: number[] = []): Model {
  const m: Model = {
    calls: 0,
    seen: [],
    call: async (request) => {
      m.calls += 1;
      m.seen.push(transcript(request.items));
      if (failAt.includes(m.calls)) {
        throw new Error('fetch failed: ECONNRESET');
      }
      return {
        items: [
          assistantMessage(`${tag}-${m.calls}`),
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
        cost: 0.01,
      };
    },
  };
  return m;
}

/** `role:text` for every message, so history drift shows up as a plain diff. */
function transcript(items: ReadonlyArray<Item>): string[] {
  return items.flatMap((item) => {
    if (item.type !== 'message') {
      return [];
    }
    const text =
      typeof item.content === 'string'
        ? item.content
        : item.content.map((part) => ('text' in part ? part.text : '')).join('');
    return [
      `${item.role}:${text}`,
    ];
  });
}

/** A harness with nothing but a storage adapter: durability must be on by default. */
function harnessOver(
  storage: StorageAdapter,
  m: Model,
  agentGraph?: AgentHarnessGraph,
): AgentHarness {
  return new AgentHarness({
    name: 'durable',
    params: {},
    agentGraph,
    environment: {
      storage: {
        adapter: storage,
      },
    },
    _testCallModel: (request) => m.call(request),
  });
}

type AgentHarnessGraph = ConstructorParameters<typeof AgentHarness>[0]['agentGraph'];

const turn = (id: string) =>
  callModel<ContextData, string, string>({
    id,
    model: 'test/model',
  });

const agentLoop = (iterations: number) =>
  loop<ContextData, string, string>({
    id: 'agent',
    steps: [
      turn('turn'),
    ],
    until: until.maxSteps(iterations),
  });

async function mustRestore(harness: AgentHarness, executionId: string): Promise<Context> {
  const ctx = await harness.restore(executionId);
  assert(ctx);
  return ctx;
}

//#endregion

describe('durable execution across harness instances', () => {
  it('resumes a loop on a new harness: finished turns replay, the model sees the same history', async () => {
    const storage = createInMemoryStorage();
    const first = model(
      'first',
      [
        20,
      ],
    );
    const ctx = harnessOver(storage, first).createContext();
    await expect(harnessOver(storage, first).run(agentLoop(25), 'go', ctx)).rejects.toThrow(
      'ECONNRESET',
    );

    const second = model('second');
    const harness = harnessOver(storage, second);
    const resumed = await mustRestore(harness, ctx.id);
    expect(await harness.run(agentLoop(25), 'go', resumed)).toBe('second-6');

    // Nineteen turns replayed for free; the cut-off turn and the five after it ran live,
    // and the cut-off turn was sent exactly the conversation it was sent before.
    expect(second.calls).toBe(6);
    expect(second.seen[0]).toEqual(first.seen[19]);
    expect(transcript(resumed.itemLog.items).filter((t) => t.startsWith('assistant'))).toHaveLength(
      25,
    );
  });

  it('a run that dies on its first step still leaves something to restore', async () => {
    const storage = createInMemoryStorage();
    const first = model(
      'first',
      [
        1,
      ],
    );
    const harness = harnessOver(storage, first);
    const ctx = harness.createContext();
    await expect(harness.run(turn('only'), 'go', ctx)).rejects.toThrow('ECONNRESET');

    expect(await harnessOver(storage, model('second')).restore(ctx.id)).not.toBeNull();
  });

  it('answers a new question afresh rather than replaying an earlier answer', async () => {
    const storage = createInMemoryStorage();
    const first = model(
      'first',
      [
        3,
      ],
    );
    const harness = harnessOver(storage, first);
    const ctx = harness.createContext();
    expect(await harness.run(turn('chat'), 'my name is Sam', ctx)).toBe('first-1');
    expect(await harness.run(turn('chat'), 'what is my name?', ctx)).toBe('first-2');
    await expect(harness.run(turn('chat'), 'write a poem', ctx)).rejects.toThrow();

    const second = model('second');
    const next = harnessOver(storage, second);
    const resumed = await mustRestore(next, ctx.id);
    expect(await next.run(turn('chat'), 'write a poem', resumed)).toBe('second-1');
    expect(transcript(resumed.itemLog.items)).toEqual([
      'user:my name is Sam',
      'assistant:first-1',
      'user:what is my name?',
      'assistant:first-2',
      'user:write a poem',
      'assistant:second-1',
    ]);
  });

  it('re-runs a recorded step whose input changed', async () => {
    const storage = createInMemoryStorage();
    const first = model(
      'first',
      [
        2,
      ],
    );
    const twoTurns = runCode<ContextData, string, string>({
      id: 'two-turns',
      execute: async (input, execCtx) => {
        const a = String(await execCtx.harness.run(turn('a'), input, execCtx));
        return String(await execCtx.harness.run(turn('b'), a, execCtx));
      },
    });
    const harness = harnessOver(storage, first);
    const ctx = harness.createContext();
    await expect(harness.run(twoTurns, 'question one', ctx)).rejects.toThrow();

    const second = model('second');
    const next = harnessOver(storage, second);
    expect(await next.run(twoTurns, 'question two', await mustRestore(next, ctx.id))).toBe(
      'second-2',
    );
    expect(second.calls).toBe(2);
  });

  it('gives an inParallel path back its own history when it resumes', async () => {
    const storage = createInMemoryStorage();
    const worker = (i: number) =>
      loop<ContextData, string, string>({
        id: `worker-${i}`,
        steps: [
          turn(`w${i}`),
        ],
        until: until.maxSteps(3),
      });
    const fan = inParallel<ContextData, string, string>({
      id: 'fan',
      mode: 'settle',
      paths: () => [
        worker(0),
        worker(1),
      ],
      // Settle lets worker 0 finish; the run then dies because worker 1 did not.
      merge: (results) =>
        results
          .map((r) => {
            if (r.status !== 'fulfilled') {
              throw new Error('a worker failed');
            }
            return r.value;
          })
          .join('|'),
    });
    // The workers take turns: call 4 is worker 1's second turn.
    const first = model(
      'first',
      [
        4,
      ],
    );
    const harness = harnessOver(storage, first);
    const ctx = harness.createContext();
    await expect(harness.run(fan, 'go', ctx)).rejects.toThrow('a worker failed');

    const second = model('second');
    const next = harnessOver(storage, second);
    await next.run(fan, 'go', await mustRestore(next, ctx.id));

    // Worker 0 replayed whole; worker 1 replayed its first turn and ran the other two,
    // the cut-off one on exactly the history it had before.
    expect(second.calls).toBe(2);
    expect(second.seen[0]).toEqual(first.seen[3]);
  });

  it('keeps the history whole when snapshot writes start failing mid-run', async () => {
    const base = createInMemoryStorage();
    let snapshotWrites = 0;
    const flaky: StorageAdapter = {
      ...base,
      set: async <T>(key: string, value: T) => {
        if (key.endsWith(':snapshot') && ++snapshotWrites > 3) {
          throw new Error('EDQUOT');
        }
        await base.set(key, value);
      },
    };
    const first = model(
      'first',
      [
        7,
      ],
    );
    const warn = console.warn;
    console.warn = () => {};
    const ctx = harnessOver(flaky, first).createContext();
    await harnessOver(flaky, first)
      .run(agentLoop(10), 'go', ctx)
      .catch(() => {});
    console.warn = warn;

    const second = model('second');
    const next = harnessOver(base, second);
    await next.run(agentLoop(10), 'go', await mustRestore(next, ctx.id));
    expect(second.seen[0]).toEqual(first.seen[6]);
  });

  it('a retried transient failure leaves the run where a resume expects it', async () => {
    const storage = createInMemoryStorage();
    // Call 2 fails and the loop retries it; call 5 ends the run.
    const first = model(
      'first',
      [
        2,
        5,
      ],
    );
    let retried = false;
    const retrying = loop<ContextData, string, string>({
      id: 'agent',
      steps: [
        turn('turn'),
      ],
      until: until.maxSteps(5),
      onError: () => {
        if (retried) {
          return 'abort';
        }
        retried = true;
        return 'retry';
      },
    });
    const ctx = harnessOver(storage, first).createContext();
    await expect(harnessOver(storage, first).run(retrying, 'go', ctx)).rejects.toThrow();

    retried = true;
    const second = model('second');
    const next = harnessOver(storage, second);
    const resumed = await mustRestore(next, ctx.id);
    await next.run(retrying, 'go', resumed);

    // Three turns finished before the crash; exactly two more ran.
    expect(second.calls).toBe(2);
    expect(transcript(resumed.itemLog.items).filter((t) => t.startsWith('assistant'))).toEqual([
      'assistant:first-1',
      'assistant:first-3',
      'assistant:first-4',
      'assistant:second-1',
      'assistant:second-2',
    ]);
  });

  it('carries spend over, so a cost budget stops where it would have', async () => {
    const storage = createInMemoryStorage();
    const budgeted = loop<ContextData, string, string>({
      id: 'agent',
      steps: [
        turn('turn'),
      ],
      until: until.maxCost(0.05),
    });
    const first = model(
      'first',
      [
        4,
      ],
    );
    const ctx = harnessOver(storage, first).createContext();
    await expect(harnessOver(storage, first).run(budgeted, 'go', ctx)).rejects.toThrow();

    const second = model('second');
    const next = harnessOver(storage, second);
    const resumed = await mustRestore(next, ctx.id);
    await next.run(budgeted, 'go', resumed);

    expect(second.calls).toBe(2);
    expect(resumed.cost).toBeCloseTo(0.05);
    expect(resumed.tokens.total).toBe(75);
  });

  it('carries ctx.state over', async () => {
    const storage = createInMemoryStorage();
    const tally = runCode<ContextData, string, string>({
      id: 'tally',
      execute: async (input, execCtx) => {
        const state = frameworkCast<{
          seen?: string[];
        }>(execCtx.state);
        state.seen = [
          ...(state.seen ?? []),
          input,
        ];
        return input;
      },
    });
    const tallied = loop<ContextData, string, string>({
      id: 'agent',
      steps: [
        turn('turn'),
        tally,
      ],
      until: until.maxSteps(4),
    });
    const first = model(
      'first',
      [
        3,
      ],
    );
    const ctx = harnessOver(storage, first).createContext({
      state: {},
    });
    await expect(harnessOver(storage, first).run(tallied, 'go', ctx)).rejects.toThrow();

    const next = harnessOver(storage, model('second'));
    const resumed = await mustRestore(next, ctx.id);
    await next.run(tallied, 'go', resumed);
    expect(resumed.state).toEqual({
      seen: [
        'first-1',
        'first-2',
        'second-1',
        'second-2',
      ],
    });
  });

  it('a finished run leaves no positional ledger entries behind', async () => {
    const storage = createInMemoryStorage();
    const harness = harnessOver(storage, model('only'));
    const ctx = harness.createContext();
    await harness.run(agentLoop(3), 'go', ctx);

    const { entries } = await createStepLedgerStore({
      storage,
    }).load(ctx.id);
    expect(entries.size).toBe(0);
  });

  it('stays ephemeral when the host opts out with checkpointStore: false', async () => {
    const storage = createInMemoryStorage();
    const harness = new AgentHarness({
      name: 'ephemeral',
      params: {},
      environment: {
        storage: {
          adapter: storage,
          checkpointStore: false,
        },
      },
      _testCallModel: (request) =>
        model(
          'only',
          [
            1,
          ],
        ).call(request),
    });
    const ctx = harness.createContext();
    await expect(harness.run(turn('only'), 'go', ctx)).rejects.toThrow();
    expect(await harness.restore(ctx.id)).toBeNull();
  });
});

describe('durable sessions across harness instances', () => {
  const chat = turn('chat');

  it('a new harness continues a thread with its history', async () => {
    const storage = createInMemoryStorage();
    const first = harnessOver(storage, model('first'), chat);
    await first.execute('hi, I am Sam', {
      threadId: 't',
    });
    await first.getAgentResponse({
      threadId: 't',
    });

    const second = model('second');
    const next = harnessOver(storage, second, chat);
    await next.execute('what is my name?', {
      threadId: 't',
    });
    await next.getAgentResponse({
      threadId: 't',
    });
    expect(second.seen[0]).toEqual([
      'user:hi, I am Sam',
      'assistant:first-1',
      'user:what is my name?',
    ]);
  });

  it('a re-delivered cut-off turn resumes on its recorded execution', async () => {
    const storage = createInMemoryStorage();
    const twoTurns = runCode<ContextData, string, string>({
      id: 'two-turns',
      execute: async (input, execCtx) => {
        const a = String(await execCtx.harness.run(turn('plan'), input, execCtx));
        return String(await execCtx.harness.run(turn('answer'), a, execCtx));
      },
    });
    const first = model(
      'first',
      [
        2,
      ],
    );
    const cutOff = harnessOver(storage, first, twoTurns);
    await cutOff.execute('hello', {
      threadId: 't',
      messageId: 'm-1',
    });
    await expect(
      cutOff.getAgentResponse({
        threadId: 't',
      }),
    ).rejects.toThrow('ECONNRESET');

    const second = model('second');
    const next = harnessOver(storage, second, twoTurns);
    await next.execute('hello', {
      threadId: 't',
      messageId: 'm-1',
    });
    const response = await next.getAgentResponse({
      threadId: 't',
    });

    // The plan step replayed; only the answer step ran, on the history the plan built.
    expect(second.calls).toBe(1);
    expect(second.seen[0]).toEqual(first.seen[1]);
    expect(transcript(response.items)).toEqual([
      'user:hello',
      'assistant:first-1',
      'user:first-1',
      'assistant:second-1',
    ]);
  });

  it('a different message after a cut-off turn starts fresh', async () => {
    const storage = createInMemoryStorage();
    const cutOff = harnessOver(
      storage,
      model(
        'first',
        [
          1,
        ],
      ),
      chat,
    );
    await cutOff.execute('first try', {
      threadId: 't',
      messageId: 'm-1',
    });
    await cutOff
      .getAgentResponse({
        threadId: 't',
      })
      .catch(() => {});

    const second = model('second');
    const next = harnessOver(storage, second, chat);
    await next.execute('something else', {
      threadId: 't',
      messageId: 'm-2',
    });
    await next.getAgentResponse({
      threadId: 't',
    });
    expect(second.seen[0]).toEqual([
      'user:something else',
    ]);
  });
});
