// Flow versions: a turn resumed under a newer version keeps what still matches,
// stops as stuck rather than redo a step that had a lasting effect, and leaves a
// trail of which version handled each step. See specs/23-durable-execution
// § Versions and § The trail.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type {
  CallModelRequest,
  ContextData,
  DecisionItem,
  LLMResponse,
  WorkflowDocument,
} from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel, invokeTool, runCode } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { hydrateWorkflow } from '../../src/builders/workflow-hydrator';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { assistantMessage, makeMessage } from '../_helpers';

//#region Fixtures

interface Model {
  calls: number;
  call: (request: CallModelRequest) => Promise<LLMResponse>;
}

/** Answers `<tag>-<n>`, and drops the connection on the calls in `failAt`. */
function model(tag: string, failAt: number[] = []): Model {
  const m: Model = {
    calls: 0,
    call: async () => {
      m.calls += 1;
      if (failAt.includes(m.calls)) {
        throw new Error('fetch failed: ECONNRESET');
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

const turn = (id: string) =>
  callModel<ContextData, string, string>({
    id,
    model: 'test/model',
  });

/** Plan, charge `amount` with a durable tool, then answer. `charges` is every charge made. */
function refundFlow(amount: number, charges: number[]) {
  const charge = tool({
    name: 'charge',
    description: 'Charge a card.',
    input: z.object({
      amount: z.number(),
    }),
    output: z.object({
      charged: z.number(),
      receipt: z.string(),
    }),
    durable: true,
    execute: async (args) => {
      charges.push(args.amount);
      return {
        charged: args.amount,
        receipt: `rcpt-${charges.length}`,
      };
    },
  });
  const chargeStep = invokeTool({
    id: 'charge',
    tool: charge,
  });
  return runCode<ContextData, string, string>({
    id: 'flow',
    execute: async (input, execCtx) => {
      await execCtx.harness.run(turn('plan'), input, execCtx);
      await execCtx.harness.run(
        chargeStep,
        {
          amount,
        },
        execCtx,
      );
      return String(await execCtx.harness.run(turn('answer'), 'charged', execCtx));
    },
  });
}

function harnessOn(opts: {
  storage: StorageAdapter;
  m: Model;
  version?: string;
  amount: number;
  charges: number[];
}): AgentHarness {
  return new AgentHarness({
    name: 'versions',
    params: {},
    version: opts.version,
    agentGraph: refundFlow(opts.amount, opts.charges),
    environment: {
      storage: {
        adapter: opts.storage,
      },
    },
    _testCallModel: (request) => opts.m.call(request),
  });
}

const thread = {
  threadId: 't',
};
const delivery = {
  threadId: 't',
  messageId: 'm-1',
};

/**
 * Runs the flow on version `v1` until the answer's model call fails: the plan and
 * the charge are recorded, and the turn is left cut off.
 */
async function cutOffAfterCharge(storage: StorageAdapter, charges: number[]): Promise<void> {
  const first = harnessOn({
    storage,
    m: model(
      'a',
      [
        2,
      ],
    ),
    version: 'v1',
    amount: 42,
    charges,
  });
  await first.execute('refund order 7', delivery);
  await expect(first.getAgentResponse(thread)).rejects.toThrow('ECONNRESET');
  expect(charges).toEqual([
    42,
  ]);
}

/** A person's decision about the thread's stuck turn, as `execute()` takes it. */
function decision(action: 'continue' | 'restart' | 'abandon'): DecisionItem {
  return {
    type: 'noetic:decision',
    action,
  };
}

async function kindOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    assert(isNoeticError(error));
    return error.noeticError.kind;
  }
  return expect.unreachable('expected a rejection');
}

//#endregion

describe('a turn resumed under a newer flow version', () => {
  it('keeps the steps that still match, and the trail shows which version ran each', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge(storage, charges);

    // The flow is redeployed as v2, unchanged where the turn has been.
    const m = model('b');
    const second = harnessOn({
      storage,
      m,
      version: 'v2',
      amount: 42,
      charges,
    });
    await second.execute('refund order 7', delivery);
    const response = await second.getAgentResponse(thread);
    expect(response.text).toBe('b-1');
    // The plan replayed and the charge was not made again; only the answer ran.
    expect(m.calls).toBe(1);
    expect(charges).toEqual([
      42,
    ]);

    const trail = await second.getAuditTrail(thread);
    const byStep = new Map(
      trail.map((mark) => [
        mark.stepId,
        mark,
      ]),
    );
    expect(byStep.get('plan')?.version).toBe('v1');
    expect(byStep.get('charge')?.version).toBe('v1');
    expect(byStep.get('answer')?.version).toBe('v2');
    // The charge left its receipt on the trail, and the trail outlived the ledger.
    expect(byStep.get('charge')?.receipt).toBe('rcpt-1');
    expect(await storage.list('execution:')).not.toEqual([]);
  });

  it('stops as stuck rather than redo a step that already had a lasting effect', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge(storage, charges);

    // v2 changes the charge. Running it would charge the card a second time.
    const m = model('b');
    const second = harnessOn({
      storage,
      m,
      version: 'v2',
      amount: 50,
      charges,
    });
    await second.execute('refund order 7', delivery);
    expect(await kindOf(() => second.getAgentResponse(thread))).toBe('turn_stuck');
    expect(charges).toEqual([
      42,
    ]);

    const [stuck] = await second.listStuckRuns();
    assert(stuck);
    expect(stuck).toMatchObject({
      threadId: 't',
      from: 'v1',
      to: 'v2',
    });
    expect(stuck.path).toContain('charge');
    // It waits for the host: no wake resumes it.
    expect(await second.wake()).toEqual([]);
    expect(await second.wake(thread)).toEqual([]);
    expect(charges).toEqual([
      42,
    ]);
  });

  it('goes on when the host accepts the difference: the changed step runs again', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge(storage, charges);
    const m = model('b');
    const second = harnessOn({
      storage,
      m,
      version: 'v2',
      amount: 50,
      charges,
    });
    await second.execute('refund order 7', delivery);
    await second.getAgentResponse(thread).catch(() => {});

    await second.execute(decision('continue'), thread);
    const response = await second.getAgentResponse(thread);
    expect(response.text).toBe('b-1');
    expect(charges).toEqual([
      42,
      50,
    ]);
    expect(await second.listStuckRuns()).toEqual([]);
    // There is nothing left to settle: a second decision is refused.
    expect(await kindOf(() => second.execute(decision('continue'), thread))).toBe('hold_refused');
    // And a decision of the wrong kind never reaches a turn.
    expect(
      await kindOf(() =>
        second.execute(
          {
            type: 'noetic:decision',
            action: 'allow',
          },
          thread,
        ),
      ),
    ).toBe('hold_refused');
  });

  it('runs from the top when the host restarts it', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge(storage, charges);
    const m = model('b');
    const second = harnessOn({
      storage,
      m,
      version: 'v2',
      amount: 50,
      charges,
    });
    await second.execute('refund order 7', delivery);
    await second.getAgentResponse(thread).catch(() => {});

    await second.execute(decision('restart'), thread);
    const response = await second.getAgentResponse(thread);
    // The plan was asked again too: nothing of the first run was kept.
    expect(m.calls).toBe(2);
    expect(response.text).toBe('b-2');
    expect(charges).toEqual([
      42,
      50,
    ]);
  });

  it('is dropped when the host abandons it, and its trail is kept', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge(storage, charges);
    const second = harnessOn({
      storage,
      m: model('b'),
      version: 'v2',
      amount: 50,
      charges,
    });
    await second.execute('refund order 7', delivery);
    await second.getAgentResponse(thread).catch(() => {});
    const [stuck] = await second.listStuckRuns();
    assert(stuck);

    await second.execute(decision('abandon'), thread);
    expect(await second.listStuckRuns()).toEqual([]);
    expect(await second.wake(thread)).toEqual([]);
    expect(charges).toEqual([
      42,
    ]);
    // A new message on the thread starts a fresh turn.
    await second.execute('never mind', {
      threadId: 't',
      messageId: 'm-2',
    });
    await second.getAgentResponse(thread);
    expect(charges).toEqual([
      42,
      50,
    ]);
  });
});

describe('a harness that names no version', () => {
  it('discards what no longer matches, as before: the changed step runs again', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    const first = harnessOn({
      storage,
      m: model(
        'a',
        [
          2,
        ],
      ),
      amount: 42,
      charges,
    });
    await first.execute('refund order 7', delivery);
    await first.getAgentResponse(thread).catch(() => {});

    const second = harnessOn({
      storage,
      m: model('b'),
      amount: 50,
      charges,
    });
    await second.execute('refund order 7', delivery);
    expect((await second.getAgentResponse(thread)).text).toBe('b-1');
    expect(charges).toEqual([
      42,
      50,
    ]);
    expect(await second.listStuckRuns()).toEqual([]);
  });
});

describe('a harness running a JSON workflow', () => {
  const document = (prompt: string): WorkflowDocument => ({
    version: 1,
    root: {
      kind: 'callModel',
      id: 'answer',
      model: 'test/model',
      instructions: prompt,
    },
  });

  /** The version the harness stamps on what a turn records. */
  async function versionOf(doc: WorkflowDocument, version?: string): Promise<string | undefined> {
    const m = model('a');
    const harness = new AgentHarness({
      name: 'versions',
      params: {},
      version,
      agentGraph: hydrateWorkflow(doc, {
        tools: new Map(),
        // A one-node document runs no child step.
        executeStep: async () => expect.unreachable('the document has no child step'),
      }),
      environment: {
        storage: {
          adapter: createInMemoryStorage(),
        },
      },
      _testCallModel: (request) => m.call(request),
    });
    await harness.execute('hello', delivery);
    await harness.getAgentResponse(thread);
    const [mark] = await harness.getAuditTrail(thread);
    assert(mark);
    return mark.version;
  }

  it('names its flow by the hash of the document', async () => {
    const first = await versionOf(document('Be brief.'));
    assert(first);
    expect(first.startsWith('workflow-')).toBe(true);
    // The same document is the same version; an edited one is another.
    expect(await versionOf(document('Be brief.'))).toBe(first);
    expect(await versionOf(document('Be thorough.'))).not.toBe(first);
  });

  it('keeps the version the host names', async () => {
    expect(await versionOf(document('Be brief.'), 'release-7')).toBe('release-7');
  });
});

describe('a decision passed to execute()', () => {
  it('is acted on first, and the message beside it starts the next turn', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge(storage, charges);
    const m = model('b');
    const second = harnessOn({
      storage,
      m,
      version: 'v2',
      amount: 50,
      charges,
    });
    await second.execute('refund order 7', delivery);
    await second.getAgentResponse(thread).catch(() => {});

    // The operator drops the stuck turn and says what to do instead, in one call.
    await second.execute(
      [
        decision('abandon'),
        makeMessage('user', 'refund order 8 instead'),
      ],
      {
        threadId: 't',
        messageId: 'm-2',
      },
    );
    const response = await second.getAgentResponse(thread);
    expect(response.text).toBe('b-2');
    expect(await second.listStuckRuns()).toEqual([]);
    // The decision itself never became part of the conversation.
    expect(JSON.stringify(response.items)).not.toContain('noetic:decision');
    expect(charges).toEqual([
      42,
      50,
    ]);
  });
});
