// Forgetting (spec 23 § Forgetting): a host says a thread or an execution is over and
// the harness deletes every record core keeps for it, after settling the spend it left
// pending, and lists what is stored so a sweep never builds a storage key.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { CallModelRequest, ContextData, ContextLayer, LLMResponse } from '@noetic-tools/types';
import { frameworkCast, isNoeticError } from '@noetic-tools/types';
import { callModel, runCode, step } from '../../src/builders/step-builders';
import { connection } from '../../src/connections/handle';
import { createInMemoryConnection } from '../../src/connections/in-memory-connection';
import { AgentHarness } from '../../src/harness/agent-harness';
import { executionsOf } from '../../src/harness/thread-record';
import type { DispatchRecord } from '../../src/runtime/durable/spend-log';
import { createSpendLog } from '../../src/runtime/durable/spend-log';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { assistantMessage } from '../_helpers';

//#region Fixtures

const PROMPT_PRICE = 1e-6;
const COMPLETION_PRICE = 1e-5;
/** The ceiling of `dispatch()` under the fake prices: 10 prompt and 2000 completion tokens. */
const DISPATCH_CEILING = PROMPT_PRICE * 10 + COMPLETION_PRICE * 2e3;
const BILLED = 0.0042;

const agent = callModel<ContextData, string, string>({
  id: 'agent',
  model: 'test/model',
});

interface Model {
  calls: number;
  /** While set, calls wait for it before answering. */
  gate?: Promise<void>;
  call(request: CallModelRequest): Promise<LLMResponse>;
}

function model(): Model {
  const m: Model = {
    calls: 0,
    call: async () => {
      m.calls += 1;
      await m.gate;
      return {
        items: [
          assistantMessage(`answer-${m.calls}`),
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

/** A thread-scoped layer: its state is kept under `layers/notes/<threadId>/`. */
const notes: ContextLayer = {
  id: 'notes',
  slot: 50,
  scope: 'thread',
  hooks: {},
};

/** A layer whose id holds a slash, as some of core's own do. */
const slashed: ContextLayer = {
  id: 'acme/notes',
  slot: 51,
  scope: 'thread',
  hooks: {},
};

function harnessOver(
  storage: StorageAdapter,
  m: Model = model(),
  lease?: {
    ttlMs?: number;
    waitMs?: number;
  },
): AgentHarness {
  const harness = new AgentHarness({
    name: 'forget',
    params: {},
    agentGraph: agent,
    interactive: true,
    contextLayers: [
      notes,
      slashed,
    ],
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: 'http://localhost:1/api/v1',
    },
    environment: {
      storage: {
        adapter: storage,
        ...(lease
          ? {
              lease,
            }
          : {}),
      },
    },
    _testCallModel: (request) => m.call(request),
  });
  useFakeSdk(harness);
  return harness;
}

/** Model prices, and generation lookups that bill only `gen-billed`. */
function useFakeSdk(harness: AgentHarness): void {
  frameworkCast<{
    llm: {
      sdkClient: unknown;
    };
  }>(harness).llm.sdkClient = {
    models: {
      get: async () => ({
        data: {
          architecture: {
            outputModalities: [
              'text',
            ],
          },
          pricing: {
            prompt: String(PROMPT_PRICE),
            completion: String(COMPLETION_PRICE),
          },
          topProvider: {
            maxCompletionTokens: 1e3,
          },
          contextLength: 8e3,
        },
      }),
    },
    generations: {
      getGeneration: async ({ id }: { id: string }) => {
        if (id !== 'gen-billed') {
          throw Object.assign(new Error('not found'), {
            statusCode: 404,
          });
        }
        return {
          data: {
            totalCost: BILLED,
            tokensPrompt: 7,
            tokensCompletion: 3,
          },
        };
      },
    },
  };
}

function dispatch(over: Partial<DispatchRecord>): DispatchRecord {
  return {
    id: crypto.randomUUID(),
    kind: 'model',
    model: 'test/model',
    requestHash: 'h',
    inputTokens: 10,
    maxOutputTokens: 2e3,
    sentAt: new Date().toISOString(),
    ...over,
  };
}

/** Run `turns` finished turns on `threadId`, each its own message. */
async function runTurns(harness: AgentHarness, threadId: string, turns: number): Promise<void> {
  for (let n = 1; n <= turns; n += 1) {
    await harness.execute(`hello ${n}`, {
      threadId,
      messageId: `${threadId}-m${n}`,
    });
    await harness.getAgentResponse({
      threadId,
    });
  }
}

/** The execution ids a thread's stored record names. */
async function storedExecutions(storage: StorageAdapter, threadId: string): Promise<string[]> {
  const record = await storage.get<{
    executions?: string[];
  }>(`session:${threadId}`);
  return record?.executions ?? [];
}

/** Leave behind what each part of an execution keeps, as a cut-off turn and pruning do. */
async function seedExecution(storage: StorageAdapter, executionId: string): Promise<void> {
  await storage.set(`execution:${executionId}:trail:000001`, {
    path: 'agent',
  });
  await storage.set(`execution:${executionId}:ledger:000002`, {
    path: 'agent',
  });
  await storage.set(`execution:${executionId}:held:call-1`, {
    callId: 'call-1',
  });
  await storage.set(`execution:${executionId}:intent:call-1`, {
    argsHash: 'a',
  });
  await storage.set(`execution:${executionId}:pending:wait-1`, {
    at: 1,
  });
  // A key core does not write, as a host's own checkpoint store might.
  await storage.set(`execution:${executionId}:layers:notes`, {
    n: 1,
  });
}

async function kindOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return isNoeticError(error) ? error.noeticError.kind : 'other';
  }
  return undefined;
}

//#endregion

describe('forget({ threadId })', () => {
  it('deletes every record of the thread and settles its spend, leaving other threads alone', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const harness = harnessOver(storage);
    // More turns than the record remembers in `done`, so the oldest are found only through `executions`.
    await runTurns(harness, 't', 22);
    await runTurns(harness, 'u', 1);
    const executions = await storedExecutions(storage, 't');
    expect(executions).toHaveLength(22);
    for (const executionId of executions) {
      await seedExecution(storage, executionId);
    }
    await storage.set('layers/notes/t/state', {
      n: 1,
    });
    const log = createSpendLog(storage);
    const billed = dispatch({
      threadId: 't',
      executionId: executions[0],
      generationId: 'gen-billed',
      path: 'agent/round#0',
    });
    const unpriced = dispatch({
      threadId: 't',
      executionId: executions[3],
    });
    await log.put(billed);
    await log.put(unpriced);
    await storage.set('spend:torn', {
      threadId: 't',
      sentAt: 42,
    });
    const elsewhere = dispatch({
      threadId: 'u',
    });
    await log.put(elsewhere);
    expect(await storage.get('output:t')).not.toBeNull();

    const report = await harness.forget(
      {
        threadId: 't',
      },
      {
        patienceMs: 0,
      },
    );

    expect(report.threadId).toBe('t');
    expect(report.executionIds).toEqual(executions);
    expect(report.spend).toEqual([
      {
        id: billed.id,
        threadId: 't',
        executionId: executions[0],
        cost: BILLED,
        inputTokens: 7,
        outputTokens: 3,
        model: 'test/model',
        path: 'agent/round#0',
      },
      {
        id: 'torn',
        threadId: 't',
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        writtenOff: true,
        unbounded: true,
      },
      {
        id: unpriced.id,
        threadId: 't',
        executionId: executions[3],
        cost: DISPATCH_CEILING,
        inputTokens: 0,
        outputTokens: 0,
        model: 'test/model',
        writtenOff: true,
      },
    ]);
    const left = await storage.list('');
    for (const key of [
      'session:t',
      'turn-lease:t',
      'output:t',
      'layers/notes/t/state',
    ]) {
      expect(left).not.toContain(key);
    }
    for (const executionId of executions) {
      expect(left.filter((key) => key.includes(executionId))).toEqual([]);
    }
    expect(left).toContain('session:u');
    expect(left).toContain('output:u');
    expect(left).toContain(`spend:${elsewhere.id}`);
    expect(await harness.listStoredThreads()).toEqual([
      'u',
    ]);
    expect(await harness.pendingSpend()).toHaveLength(1);
  });

  it('keeps the trail with keepTrail, and the thread runs again from nothing', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const harness = harnessOver(storage);
    await runTurns(harness, 't', 2);
    const executions = await storedExecutions(storage, 't');
    for (const executionId of executions) {
      await seedExecution(storage, executionId);
    }

    await harness.forget(
      {
        threadId: 't',
      },
      {
        keepTrail: true,
        patienceMs: 0,
      },
    );

    const kept = await storage.list('execution:');
    expect(kept.length).toBeGreaterThanOrEqual(executions.length);
    expect(kept.every((key) => key.includes(':trail:'))).toBe(true);
    expect(await harness.listStoredThreads()).toEqual([]);
    expect(
      (await harness.listStoredExecutions()).map(({ parts, resumable }) => ({
        parts,
        resumable,
      })),
    ).toEqual([
      {
        parts: [
          'trail',
        ],
        resumable: false,
      },
      {
        parts: [
          'trail',
        ],
        resumable: false,
      },
    ]);

    await runTurns(harness, 't', 1);
    const fresh = await storage.get<{
      items: unknown[];
      executions: string[];
    }>('session:t');
    assert(fresh);
    expect(fresh.executions).toHaveLength(1);
    // Only the new turn's message and answer: the forgotten history is gone.
    expect(fresh.items).toHaveLength(2);
  });

  it('a thread forgotten on a harness that never ran it finds everything from storage', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    await runTurns(harnessOver(storage), 't', 3);

    const report = await harnessOver(storage).forget(
      {
        threadId: 't',
      },
      {
        patienceMs: 0,
      },
    );

    expect(report.executionIds).toHaveLength(3);
    expect(await storage.list('')).toEqual([]);
  });

  it('refuses a thread whose turn runs in this harness', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const m = model();
    let open = (): void => {};
    m.gate = new Promise((resolve) => {
      open = resolve;
    });
    const harness = harnessOver(storage, m);
    await harness.execute('hello', {
      threadId: 't',
      messageId: 'm1',
    });
    while (m.calls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const record = await storage.get<{
      turn?: {
        executionId: string;
      };
    }>('session:t');
    const running = record?.turn?.executionId;
    assert(running);

    expect(
      await kindOf(() =>
        harness.forget({
          threadId: 't',
        }),
      ),
    ).toBe('lease_lost');
    expect(
      await kindOf(() =>
        harness.forget({
          executionId: running,
        }),
      ),
    ).toBe('lease_lost');
    open();
    await harness.getAgentResponse({
      threadId: 't',
    });
    expect(await storage.get('session:t')).not.toBeNull();
  });

  it('refuses a thread another harness holds the lease of, until it runs out', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const harness = harnessOver(storage);
    await runTurns(harness, 't', 1);
    const now = Date.now();
    await storage.set('turn-lease:t', {
      term: 9,
      holder: 'elsewhere',
      heldUntil: now + 60e3,
    });

    expect(
      await kindOf(() =>
        harness.forget(
          {
            threadId: 't',
          },
          {
            patienceMs: 0,
          },
        ),
      ),
    ).toBe('lease_lost');
    expect(await storage.get('session:t')).not.toBeNull();

    await storage.set('turn-lease:t', {
      term: 9,
      holder: 'elsewhere',
      heldUntil: Date.now() + 50,
    });
    await harness.forget(
      {
        threadId: 't',
      },
      {
        patienceMs: 0,
        waitMs: 2e3,
      },
    );
    expect(await storage.list('')).toEqual([]);
  });

  it('a thread with only a lease left, from a forget cut off part way, is listed and finished', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    await storage.set('turn-lease:t', {
      term: 3,
      holder: 'gone',
      heldUntil: 0,
    });
    const harness = harnessOver(storage);
    expect(await harness.listStoredThreads()).toEqual([
      't',
    ]);
    await harness.forget(
      {
        threadId: 't',
      },
      {
        patienceMs: 0,
      },
    );
    expect(await storage.list('')).toEqual([]);
  });
});

describe('forget({ executionId })', () => {
  it('deletes the execution and its layer state, settles its spend, and leaves the rest', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const harness = harnessOver(storage);
    await seedExecution(storage, 'job-1');
    await seedExecution(storage, 'job-1:child');
    await seedExecution(storage, 'job-2');
    await storage.set('execution:job-1:snapshot', {
      junk: true,
    });
    const log = createSpendLog(storage);
    const own = dispatch({
      executionId: 'job-1',
    });
    const other = dispatch({
      executionId: 'job-2',
    });
    await log.put(own);
    await log.put(other);

    const report = await harness.forget(
      {
        executionId: 'job-1',
      },
      {
        patienceMs: 0,
      },
    );

    expect(report.executionIds).toEqual([
      'job-1',
    ]);
    expect(report.spend.map((settlement) => settlement.id)).toEqual([
      own.id,
    ]);
    expect(
      (await storage.list('')).filter((key) => key.includes('job-1') && !key.includes('child')),
    ).toEqual([]);
    expect(await harness.listStoredExecutions()).toEqual([
      {
        executionId: 'job-1:child',
        parts: [
          'trail',
          'ledger',
          'held',
          'intent',
          'pending',
          'other',
        ],
        resumable: true,
      },
      {
        executionId: 'job-2',
        parts: [
          'trail',
          'ledger',
          'held',
          'intent',
          'pending',
          'other',
        ],
        resumable: true,
      },
    ]);
  });

  it('keeps the trail with keepTrail', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const harness = harnessOver(storage);
    await seedExecution(storage, 'job-1');

    await harness.forget(
      {
        executionId: 'job-1',
      },
      {
        keepTrail: true,
        patienceMs: 0,
      },
    );

    expect(await harness.listStoredExecutions()).toEqual([
      {
        executionId: 'job-1',
        parts: [
          'trail',
        ],
        resumable: false,
      },
    ]);
  });
});

describe('listing what is stored', () => {
  it('lists threads and executions by prefix', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const harness = harnessOver(storage);
    await runTurns(harness, 'resp_a_1', 1);
    await runTurns(harness, 'resp_b_1', 1);
    await storage.set('execution:job-1:snapshot', {});
    await storage.set('execution:job-2:something-else', {});

    expect(
      await harness.listStoredThreads({
        prefix: 'resp_a_',
      }),
    ).toEqual([
      'resp_a_1',
    ]);
    expect(
      await harness.listStoredExecutions({
        prefix: 'job-',
      }),
    ).toEqual([
      {
        executionId: 'job-1',
        parts: [
          'snapshot',
        ],
        resumable: true,
      },
      {
        executionId: 'job-2',
        parts: [
          'other',
        ],
        resumable: false,
      },
    ]);
  });

  it('is empty without storage, but for display output held in memory', async () => {
    const m = model();
    const harness = new AgentHarness({
      name: 'forget',
      params: {},
      agentGraph: agent,
      interactive: true,
      _testCallModel: (request) => m.call(request),
    });
    await harness.execute('hello', {
      threadId: 't',
    });
    await harness.getAgentResponse({
      threadId: 't',
    });

    expect(await harness.listStoredExecutions()).toEqual([]);
    expect(await harness.listStoredThreads()).toEqual([
      't',
    ]);
    const report = await harness.forget({
      threadId: 't',
    });
    expect(report).toEqual({
      threadId: 't',
      executionIds: [],
      spend: [],
    });
    expect(await harness.listStoredThreads()).toEqual([]);
  });
});

describe('executionsOf', () => {
  it('lists begun executions, then remembered ones from older records, then the turn in flight', () => {
    expect(executionsOf(undefined)).toEqual([]);
    // A record written before `executions` was kept.
    expect(
      executionsOf({
        items: [],
        done: [
          {
            messageIds: [],
            text: '',
            executionId: 'a',
          },
          {
            messageIds: [],
            text: '',
          },
        ],
        turn: {
          executionId: 'b',
          messageIds: [],
        },
      }),
    ).toEqual([
      'a',
      'b',
    ]);
    expect(
      executionsOf({
        items: [],
        executions: [
          'a',
          'b',
          'c',
        ],
        done: [
          {
            messageIds: [],
            text: '',
            executionId: 'b',
          },
        ],
        turn: {
          executionId: 'a',
          messageIds: [],
        },
      }),
    ).toEqual([
      'b',
      'c',
      'a',
    ]);
  });
});

//#region Races and edge cases

/** `storage` with every delete slowed by `ms`, as a networked store is. */
function slowDeletes(storage: StorageAdapter, ms: number): StorageAdapter {
  return Object.assign(Object.create(storage), {
    delete: async (key: string) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return storage.delete(key);
    },
  });
}

describe('forget against turns that start meanwhile', () => {
  it('a message for the thread sent during its forget runs afterwards, on a fresh thread', async () => {
    const memory = createInMemoryStorage({
      swap: true,
    });
    const storage = slowDeletes(memory, 5);
    const harness = harnessOver(storage);
    await runTurns(harness, 't', 3);
    const old = await storedExecutions(memory, 't');

    const forgetting = harness.forget(
      {
        threadId: 't',
      },
      {
        patienceMs: 0,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await harness.execute('late', {
      threadId: 't',
      messageId: 'late',
    });
    const report = await forgetting;
    const response = await harness.getAgentResponse({
      threadId: 't',
    });

    expect(report.executionIds).toEqual(old);
    expect(response.text).toStartWith('answer-');
    const fresh = await storedExecutions(memory, 't');
    expect(fresh).toHaveLength(1);
    expect(old).not.toContain(fresh[0]);
    for (const executionId of old) {
      expect((await memory.list('')).filter((key) => key.includes(executionId))).toEqual([]);
    }
  });

  it('holds the lease for as long as the forget runs, so another harness cannot start a turn', async () => {
    const memory = createInMemoryStorage({
      swap: true,
    });
    const lease = {
      ttlMs: 60,
      waitMs: 0,
    };
    // Deletes wait at a gate the test opens, so the forget is surely still running.
    let reached = (): void => {};
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let gated = false;
    const storage: StorageAdapter = Object.assign(Object.create(memory), {
      delete: async (key: string) => {
        if (gated) {
          reached();
          await gate;
        }
        return memory.delete(key);
      },
    });
    const harness = harnessOver(storage, model(), lease);
    await runTurns(harness, 't', 2);
    gated = true;
    const other = new AgentHarness({
      name: 'other',
      params: {},
      agentGraph: agent,
      environment: {
        storage: {
          adapter: memory,
          lease,
        },
      },
      _testCallModel: (request) => model().call(request),
    });

    const forgetting = harness.forget(
      {
        threadId: 't',
      },
      {
        patienceMs: 0,
      },
    );
    await atGate;
    // Well past one lease period into a forget that takes several.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await other.execute('meanwhile', {
      threadId: 't',
    });
    expect(
      await kindOf(() =>
        other.getAgentResponse({
          threadId: 't',
        }),
      ),
    ).toBe('lease_lost');
    open();
    await forgetting;

    expect(await memory.list('')).toEqual([]);
  });

  it('refuses a second forget of a thread already being forgotten', async () => {
    const memory = createInMemoryStorage({
      swap: true,
    });
    const harness = harnessOver(slowDeletes(memory, 5));
    await runTurns(harness, 't', 2);
    const first = harness.forget(
      {
        threadId: 't',
      },
      {
        patienceMs: 0,
      },
    );
    expect(
      await kindOf(() =>
        harness.forget({
          threadId: 't',
        }),
      ),
    ).toBe('lease_lost');
    await first;
    expect(await memory.list('')).toEqual([]);
  });
});

describe('forget leaves what is not the thread’s', () => {
  it('keeps the layer state of thread "a/b" when forgetting "a", and finds layers whose ids hold a slash', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const harness = harnessOver(storage);
    await runTurns(harness, 'a', 1);
    await runTurns(harness, 'a/b', 1);
    await runTurns(harness, 'notes', 1);
    for (const key of [
      'layers/notes/a/state',
      'layers/notes/a/b/state',
      'layers/acme/notes/a/state',
      'layers/acme/notes/notes/state',
      'layers/notes/notes/state',
    ]) {
      await storage.set(key, {
        n: 1,
      });
    }

    await harness.forget(
      {
        threadId: 'a',
      },
      {
        patienceMs: 0,
      },
    );

    expect(await storage.list('layers/')).toEqual([
      'layers/notes/a/b/state',
      'layers/acme/notes/notes/state',
      'layers/notes/notes/state',
    ]);
    await harness.forget(
      {
        threadId: 'notes',
      },
      {
        patienceMs: 0,
      },
    );
    expect(await storage.list('layers/')).toEqual([
      'layers/notes/a/b/state',
    ]);
  });

  it('a harness without the layer configured finds it in the thread record', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    await runTurns(harnessOver(storage), 't', 1);
    await storage.set('layers/acme/notes/t/state', {
      n: 1,
    });
    const bare = new AgentHarness({
      name: 'bare',
      params: {},
      environment: {
        storage: {
          adapter: storage,
        },
      },
    });

    await bare.forget(
      {
        threadId: 't',
      },
      {
        patienceMs: 0,
      },
    );

    expect(await storage.list('')).toEqual([]);
  });
});

describe('forget and spend', () => {
  it('waits no longer than patienceMs for a lookup already running', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const harness = harnessOver(storage);
    const slow = dispatch({
      executionId: 'job-1',
      generationId: 'gen-never',
    });
    await createSpendLog(storage).put(slow);
    const reconciling = harness.reconcileSpend({
      patienceMs: 30e3,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const started = Date.now();
    const report = await harness.forget(
      {
        executionId: 'job-1',
      },
      {
        patienceMs: 50,
      },
    );

    expect(Date.now() - started).toBeLessThan(2e3);
    expect(report.spend).toEqual([
      {
        id: slow.id,
        executionId: 'job-1',
        cost: DISPATCH_CEILING,
        inputTokens: 0,
        outputTokens: 0,
        model: 'test/model',
        writtenOff: true,
      },
    ]);
    expect(await reconciling).toEqual([]);
  });

  it('stops before deleting anything when a spend record cannot be settled', async () => {
    const memory = createInMemoryStorage({
      swap: true,
    });
    const storage: StorageAdapter = Object.assign(Object.create(memory), {
      delete: async (key: string) => {
        if (key.startsWith('spend:')) {
          throw new Error('storage is unavailable');
        }
        return memory.delete(key);
      },
    });
    const harness = harnessOver(storage);
    await runTurns(harness, 't', 1);
    await createSpendLog(memory).put(
      dispatch({
        threadId: 't',
      }),
    );

    expect(
      await kindOf(() =>
        harness.forget(
          {
            threadId: 't',
          },
          {
            patienceMs: 0,
          },
        ),
      ),
    ).toBe('ledger_write_failed');
    expect(await memory.get('session:t')).not.toBeNull();
    // The lease was handed back: a forget that works can run at once.
    const lease = await memory.get<{
      heldUntil: number;
    }>('turn-lease:t');
    expect(lease?.heldUntil).toBe(0);
  });
});

describe('forget scope', () => {
  it('refuses a scope with neither a thread nor an execution', async () => {
    const harness = harnessOver(
      createInMemoryStorage({
        swap: true,
      }),
    );
    await expect(
      harness.forget(
        frameworkCast<{
          threadId: string;
        }>({}),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_FORGET_SCOPE',
    });
  });
});

//#endregion

describe('forget and connection-pool leases', () => {
  it('deletes the lease records a crashed run left, its parallel paths’ and old records’ included', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const harness = harnessOver(storage);
    const later = Date.now() + 60e3;
    await storage.set('noetic/connections/leases/browsers/job-1', {
      id: 'l1',
      expiresAt: later,
      executionId: 'job-1',
    });
    // A model tool's lease held by a context under the run, keyed by that context's id.
    await storage.set('noetic/connections/leases/browsers/ctx-under-job-1', {
      id: 'l2',
      expiresAt: later,
      executionId: 'job-1',
    });
    // Written before leases named their run: found by holder.
    await storage.set('noetic/connections/leases/team/browsers/job-1:path:p1', {
      id: 'l3',
      expiresAt: later,
    });
    await storage.set('noetic/connections/leases/browsers/job-2', {
      id: 'l4',
      expiresAt: later,
      executionId: 'job-2',
    });
    await storage.set('noetic/connections/leases/browsers/job-10', {
      id: 'l5',
      expiresAt: later,
    });

    await harness.forget(
      {
        executionId: 'job-1',
      },
      {
        patienceMs: 0,
      },
    );

    expect(await storage.list('noetic/connections/leases/')).toEqual([
      'noetic/connections/leases/browsers/job-2',
      'noetic/connections/leases/browsers/job-10',
    ]);
  });

  it('releases a lease this harness still holds for a failed run, and frees its connection', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const provider = createInMemoryConnection({
      operations: {
        'browser.ping': {
          run: () => 'pong',
        },
      },
      provision: () => undefined,
    });
    const harness = new AgentHarness({
      name: 'pooled',
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
      environment: {
        storage: {
          adapter: storage,
        },
      },
    });
    const ping = step.call({
      id: 'leased',
      connection: connection('browsers', undefined, {
        fresh: 'run',
      }),
      op: 'browser.ping',
    });
    const failing = runCode<ContextData, undefined, undefined>({
      id: 'fails-after-leasing',
      execute: async (input, execCtx) => {
        await execCtx.harness.run(ping, input, execCtx);
        throw new Error('crashed after leasing');
      },
    });
    const ctx = harness.createContext();
    await expect(harness.run(failing, undefined, ctx)).rejects.toThrow('crashed after leasing');
    // A failed run keeps its lease for a resume.
    expect(harness.getConnectionStatus('browsers')[0]?.pool?.leased).toBe(1);
    const [leaseKey] = await storage.list('noetic/connections/leases/');
    assert(leaseKey);
    expect(await storage.get(leaseKey)).toMatchObject({
      executionId: ctx.id,
    });

    await harness.forget(
      {
        executionId: ctx.id,
      },
      {
        patienceMs: 0,
      },
    );

    expect(harness.getConnectionStatus('browsers')[0]?.pool?.leased).toBe(0);
    expect(provider.provisioned[0]?.released).toBe(true);
    expect(await storage.list('noetic/connections/leases/')).toEqual([]);
    await harness.close();
  });
});
