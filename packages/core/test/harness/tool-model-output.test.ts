// `Tool.toModelOutput`: what the model is given as a call's result, while the result
// item, the completed event and the call's record keep the tool's JSON output.
// Drives the real model client against a fake server. See specs/02-step-variants
// § Tool Definition.

import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { ContextData, StreamEvent } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel } from '../../src/builders/step-builders';
import { hold, tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { FakeOpenRouter } from '../_helpers';
import { startFakeOpenRouter } from '../_helpers';

//#region Fixtures

const THREAD = {
  threadId: 't',
};

const SentOutputSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string(),
  output: z.unknown(),
});

/** What each function call's result was sent to the model as, by call id. */
function sentOutputs(input: unknown[] | undefined): Record<string, unknown> {
  const sent: Record<string, unknown> = {};
  for (const entry of input ?? []) {
    const parsed = SentOutputSchema.safeParse(entry);
    if (parsed.success) {
      sent[parsed.data.call_id] = parsed.data.output;
    }
  }
  return sent;
}

function call(name: string, args: Record<string, unknown>): unknown {
  return {
    type: 'function_call',
    id: `fc_${name}`,
    call_id: `call_${name}`,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
}

const DONE = [
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

/** One round asking for `calls`, then an answer once every result is in. */
function modelAsking(calls: unknown[]): (input: unknown[]) => unknown[] {
  return (input) => (Object.keys(sentOutputs(input)).length >= calls.length ? DONE : calls);
}

function imageOf(path: string): {
  type: 'input_image';
  imageUrl: string;
} {
  return {
    type: 'input_image',
    imageUrl: `data:image/png;base64,${path}`,
  };
}

interface Setup {
  server: FakeOpenRouter;
  agent: ReturnType<typeof callModel<ContextData, string, string>>;
  /** Every time a tool body ran, by tool name. */
  runs: string[];
  /** The results `toModelOutput` was called with, in order. */
  shown: unknown[];
  harness: (storage?: StorageAdapter) => AgentHarness;
}

/**
 * `screenshot` returns a path and shows the model the image; `broken_shot` fails;
 * `bad_view` has a `toModelOutput` that throws; `ask_person` leaves its result open
 * and shows the model the answer in capitals.
 */
function setup(reply: (input: unknown[]) => unknown[]): Setup {
  const server = startFakeOpenRouter(reply);
  servers.push(server);
  const runs: string[] = [];
  const shown: unknown[] = [];
  const shot = z.object({
    path: z.string(),
  });
  const page = z.object({
    page: z.string(),
  });
  const screenshot = tool({
    name: 'screenshot',
    description: 'Capture a page.',
    input: page,
    output: shot,
    execute: async (args) => {
      runs.push('screenshot');
      return {
        path: `${args.page}.png`,
      };
    },
    toModelOutput: (result, args) => {
      shown.push(result);
      return [
        {
          type: 'input_text',
          text: `Screenshot of ${args.page}`,
        },
        imageOf(result.path),
      ];
    },
  });
  const brokenShot = tool({
    name: 'broken_shot',
    description: 'Capture a page, badly.',
    input: page,
    output: shot,
    execute: async () => {
      throw new Error('camera offline');
    },
    toModelOutput: (result) => {
      shown.push(result);
      return 'never shown';
    },
  });
  const badView = tool({
    name: 'bad_view',
    description: 'Capture a page, with a view that throws.',
    input: page,
    output: shot,
    execute: async (args) => ({
      path: `${args.page}.png`,
    }),
    toModelOutput: () => {
      throw new Error('no encoder');
    },
  });
  const askPerson = tool({
    name: 'ask_person',
    description: 'Ask a person a question.',
    input: z.object({
      question: z.string(),
    }),
    output: z.string(),
    execute: async () => {
      runs.push('ask_person');
      return hold();
    },
    toModelOutput: (result) => {
      shown.push(result);
      return result.toUpperCase();
    },
  });
  const agent = callModel<ContextData, string, string>({
    id: 'agent',
    model: 'test/model',
    tools: [
      screenshot,
      brokenShot,
      badView,
      askPerson,
    ],
  });
  return {
    server,
    agent,
    runs,
    shown,
    harness: (storage) =>
      new AgentHarness({
        name: 'shots',
        params: {},
        agentGraph: agent,
        callModelDefaults: {
          provider: 'openrouter',
          apiKey: 'sk-test',
          baseUrl: server.baseUrl,
        },
        ...(storage
          ? {
              environment: {
                storage: {
                  adapter: storage,
                  lease: {
                    waitMs: 0,
                  },
                  park: {
                    graceMs: 0,
                  },
                },
              },
            }
          : {}),
      }),
  };
}

/** Collect the thread's framework events of one type until the stream is left. */
function watch(harness: AgentHarness, type: string): Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = [];
  void collectEvents(harness.getFullStream(THREAD), `shots:${type}`, seen);
  return seen;
}

async function collectEvents(
  stream: AsyncIterable<StreamEvent>,
  type: string,
  seen: Record<string, unknown>[],
): Promise<void> {
  for await (const event of stream) {
    if (event.type === type) {
      seen.push(event.data);
    }
  }
}

const SHOT_SENT = [
  {
    type: 'input_text',
    text: 'Screenshot of home',
  },
  {
    type: 'input_image',
    detail: 'auto',
    image_url: 'data:image/png;base64,home.png',
  },
];

const servers: FakeOpenRouter[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

//#endregion

describe('Tool.toModelOutput', () => {
  it('gives the model its content, and keeps the JSON output everywhere else', async () => {
    const { server, shown, harness } = setup(
      modelAsking([
        call('screenshot', {
          page: 'home',
        }),
      ]),
    );
    const h = harness();
    const completed = watch(h, 'tool_call_completed');
    await h.execute('look at home', THREAD);
    const response = await h.getAgentResponse(THREAD);

    expect(sentOutputs(server.rounds[1]?.input)).toEqual({
      call_screenshot: SHOT_SENT,
    });
    expect(shown).toEqual([
      {
        path: 'home.png',
      },
    ]);
    // The result item and the event carry the tool's JSON output, not the image.
    const item = response.items.find((entry) => entry.type === 'function_call_output');
    assert(item?.type === 'function_call_output');
    expect(item.output).toBe('{"path":"home.png"}');
    expect(completed).toEqual([
      {
        name: 'screenshot',
        callId: 'call_screenshot',
        error: false,
        output: '{"path":"home.png"}',
      },
    ]);
  });

  it('is not asked about a call that failed: the model gets the error text', async () => {
    const { server, shown, harness } = setup(
      modelAsking([
        call('broken_shot', {
          page: 'home',
        }),
      ]),
    );
    const h = harness();
    await h.execute('look at home', THREAD);
    await h.getAgentResponse(THREAD);

    expect(sentOutputs(server.rounds[1]?.input)).toEqual({
      call_broken_shot: 'Error: camera offline',
    });
    expect(shown).toEqual([]);
  });

  it('falls back to the JSON output, and says so, when it throws', async () => {
    const { server, harness } = setup(
      modelAsking([
        call('bad_view', {
          page: 'home',
        }),
      ]),
    );
    const h = harness();
    const failed = watch(h, 'tool_model_output_failed');
    await h.execute('look at home', THREAD);
    expect((await h.getAgentResponse(THREAD)).text).toBe('done');

    expect(sentOutputs(server.rounds[1]?.input)).toEqual({
      call_bad_view: '{"path":"home.png"}',
    });
    expect(failed).toEqual([
      {
        name: 'bad_view',
        callId: 'call_bad_view',
        error: 'no encoder',
      },
    ]);
  });

  it('shows a replayed call and a held call answered with an output the same way', async () => {
    const { server, runs, shown, harness } = setup(
      modelAsking([
        call('screenshot', {
          page: 'home',
        }),
        call('ask_person', {
          question: 'Is this the right page?',
        }),
      ]),
    );
    const storage = createInMemoryStorage({
      swap: true,
    });
    const first = harness(storage);
    await first.execute('look at home', {
      ...THREAD,
      messageId: 'm-1',
    });
    // The screenshot ran and is on record; the question waits for a person.
    assert((await first.getAgentResponse(THREAD)).parked);
    await first.close();

    const second = harness(storage);
    const [held] = await second.pending(THREAD);
    assert(held);
    await second.execute(
      {
        type: 'noetic:decision',
        callId: held.callId,
        output: 'yes, that one',
      },
      THREAD,
    );
    expect((await second.getAgentResponse(THREAD)).text).toBe('done');

    // Neither body ran again: the screenshot came from its record, expanded back to
    // the result `toModelOutput` reads, and the answer went through it too.
    expect(runs).toEqual([
      'screenshot',
      'ask_person',
    ]);
    expect(shown).toEqual([
      {
        path: 'home.png',
      },
      {
        path: 'home.png',
      },
      'yes, that one',
    ]);
    expect(sentOutputs(server.rounds[1]?.input)).toEqual({
      call_screenshot: SHOT_SENT,
      call_ask_person: 'YES, THAT ONE',
    });
    await second.close();
  });

  it('sends a finished round again as it was sent, when a later round is cut off', async () => {
    const { server, agent, runs, harness } = setup(
      modelAsking([
        call('screenshot', {
          page: 'home',
        }),
      ]),
    );
    server.dropAt.add(2);
    const storage = createInMemoryStorage();
    const first = harness(storage);
    const ctx = first.createContext();
    await expect(first.run(agent, 'look at home', ctx)).rejects.toThrow();

    const next = harness(storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(agent, 'look at home', resumed)).toBe('done');

    expect(runs).toEqual([
      'screenshot',
    ]);
    expect(server.rounds).toHaveLength(3);
    expect(sentOutputs(server.rounds[2]?.input)).toEqual({
      call_screenshot: SHOT_SENT,
    });
  });
});
