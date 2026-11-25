// An interactive harness keeps each thread's streamed output for display.
// Drives the real model client against a fake server. See specs/08-runtime
// § Display output.

import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { ContextData } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { callModel } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { EventBroadcaster } from '../../src/runtime/event-broadcaster';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { OutputSnapshot } from '../../src/runtime/output-store';
import { OutputStoreError } from '../../src/runtime/output-store';
import type { FakeOpenRouter } from '../_helpers';
import { startFakeOpenRouter } from '../_helpers';

//#region Fixtures

const THREAD = {
  threadId: 't',
};

/** Each reply is a new message, as a provider's is: the reply to `n` inputs is `msg_<n>`. */
function answer(input: unknown[]): unknown[] {
  return [
    {
      type: 'message',
      id: `msg_${input.length}`,
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'hello there',
          annotations: [],
        },
      ],
    },
  ];
}

const agent = callModel<ContextData, string, string>({
  id: 'agent',
  model: 'test/model',
});

function setup(): {
  server: FakeOpenRouter;
  harness: (opts: { storage: StorageAdapter; interactive?: boolean }) => AgentHarness;
} {
  const server = startFakeOpenRouter(answer, {
    streamed: true,
  });
  servers.push(server);
  return {
    server,
    harness: (opts) =>
      new AgentHarness({
        name: 'chat',
        params: {},
        agentGraph: agent,
        interactive: opts.interactive,
        callModelDefaults: {
          provider: 'openrouter',
          apiKey: 'sk-test',
          baseUrl: server.baseUrl,
        },
        environment: {
          storage: {
            adapter: opts.storage,
          },
        },
      }),
  };
}

/** `role: text` of each message snapshot, with `…` for an unfinished one. */
function transcript(items: ReadonlyArray<OutputSnapshot>): string[] {
  return items.flatMap((item) => {
    if (item.type !== 'message' || !Array.isArray(item.content)) {
      return [];
    }
    const text = item.content.map((part: { text?: string }) => part.text ?? '').join('');
    return [
      `${String(item.role)}: ${text}${item.isComplete ? '' : '…'}`,
    ];
  });
}

/** `storage`, with writes to `output:` keys held back `ms`, or failing. */
function outputWrites(
  storage: StorageAdapter,
  how: {
    delayMs?: number;
    fail?: boolean;
  },
): StorageAdapter {
  return {
    ...storage,
    get: (key) => storage.get(key),
    delete: (key) => storage.delete(key),
    list: (prefix) => storage.list(prefix),
    async set<T>(key: string, value: T): Promise<void> {
      if (key.startsWith('output:')) {
        if (how.fail) {
          throw new Error('disk full');
        }
        await new Promise((resolve) => setTimeout(resolve, how.delayMs ?? 0));
      }
      await storage.set(key, value);
    },
  };
}

const servers: FakeOpenRouter[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

//#endregion

describe('an interactive harness', () => {
  it('keeps a turn’s output, and a new harness over the same storage reads it', async () => {
    const { harness } = setup();
    const storage = createInMemoryStorage();
    const first = harness({
      storage,
      interactive: true,
    });
    await first.execute('hi', THREAD);
    await first.getAgentResponse(THREAD);
    expect(transcript(await first.getSessionOutput(THREAD))).toEqual([
      'user: hi',
      'assistant: hello there',
    ]);
    await first.close();

    // A later process, which never ran the thread and records nothing itself.
    const later = harness({
      storage,
    });
    expect(transcript(await later.getSessionOutput(THREAD))).toEqual([
      'user: hi',
      'assistant: hello there',
    ]);
    expect(
      await later.getSessionOutput({
        threadId: 'another',
      }),
    ).toEqual([]);
  });

  it('adds a later turn to what an earlier harness kept', async () => {
    const { harness } = setup();
    const storage = createInMemoryStorage();
    const first = harness({
      storage,
      interactive: true,
    });
    await first.execute('hi', THREAD);
    await first.getAgentResponse(THREAD);
    await first.close();

    const second = harness({
      storage,
      interactive: true,
    });
    await second.execute('again', THREAD);
    await second.getAgentResponse(THREAD);
    expect(transcript(await second.getSessionOutput(THREAD))).toEqual([
      'user: hi',
      'assistant: hello there',
      'user: again',
      'assistant: hello there',
    ]);
    await second.close();
  });

  it('keeps display output apart from checkpoints, under output:<threadId>', async () => {
    const { harness } = setup();
    const storage = createInMemoryStorage();
    const h = harness({
      storage,
      interactive: true,
    });
    await h.execute('hi', THREAD);
    await h.getAgentResponse(THREAD);
    await h.close();
    expect(await storage.list('output:')).toEqual([
      'output:t',
    ]);
  });

  it('streams and records run() on a context the host built for the thread', async () => {
    const { harness } = setup();
    const storage = createInMemoryStorage();
    const h = harness({
      storage,
      interactive: true,
    });
    const ctx = h.createContext(THREAD);
    expect(ctx.threadId).toBe('t');
    expect(await h.run(agent, 'hi', ctx)).toBe('hello there');

    // The write is done when run() returns: nothing here waits on the store.
    const stored = await storage.get<OutputSnapshot[]>('output:t');
    assert(stored);
    expect(transcript(stored)).toContain('assistant: hello there');
  });

  it('makes a context with no thread its own thread, and leaves child contexts alone', async () => {
    const { harness } = setup();
    const h = harness({
      storage: createInMemoryStorage(),
      interactive: true,
    });
    const root = h.createContext();
    expect(root.threadId).toBe(root.id);
    await h.run(agent, 'hi', root);
    expect(
      transcript(
        await h.getSessionOutput({
          threadId: root.id,
        }),
      ),
    ).toContain('assistant: hello there');

    const child = h.createContext({
      parent: root,
    });
    expect(child.threadId).not.toBe(child.id);
    expect('_broadcaster' in child && child._broadcaster).toBeFalsy();
  });

  it('saves what a failed run streamed before the failure is thrown', async () => {
    const { server, harness } = setup();
    server.dropAt.add(1);
    const storage = createInMemoryStorage();
    const h = harness({
      // Slow enough that only a flush the run waits for gets the item saved in time.
      storage: outputWrites(storage, {
        delayMs: 30,
      }),
      interactive: true,
    });
    const ctx = h.createContext(THREAD);
    const broadcaster = frameworkCast<EventBroadcaster>(h.getFullStream(THREAD));
    const run = h.run(agent, 'hi', ctx);
    broadcaster.emit({
      source: 'framework',
      type: 'chat:item_appended',
      data: {
        item: {
          id: 'first',
          type: 'message',
          role: 'user',
          content: [],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    broadcaster.emit({
      source: 'framework',
      type: 'chat:item_appended',
      data: {
        item: {
          id: 'last',
          type: 'message',
          role: 'user',
          content: [],
        },
      },
    });
    await expect(run).rejects.toThrow();

    const stored = await storage.get<OutputSnapshot[]>('output:t');
    assert(stored);
    expect(stored.map((item) => item.id)).toEqual([
      'first',
      'last',
    ]);
  });

  it('fails a run whose output could not be saved, though its step finished', async () => {
    const { harness } = setup();
    const h = harness({
      storage: outputWrites(createInMemoryStorage(), {
        fail: true,
      }),
      interactive: true,
    });
    const ctx = h.createContext(THREAD);
    const error = await h.run(agent, 'hi', ctx).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert(error instanceof OutputStoreError);
    expect(error.scope).toBe('t');
    expect(error.message).toBe('Could not write streamed output.');
  });

  it('close() saves what was streamed outside a run', async () => {
    const { harness } = setup();
    const storage = createInMemoryStorage();
    const h = harness({
      storage: outputWrites(storage, {
        delayMs: 30,
      }),
      interactive: true,
    });
    frameworkCast<EventBroadcaster>(h.getFullStream(THREAD)).emit({
      source: 'framework',
      type: 'chat:item_appended',
      data: {
        item: {
          id: 'late',
          type: 'message',
          role: 'user',
          content: [],
        },
      },
    });
    await h.close();
    expect(await storage.get<OutputSnapshot[]>('output:t')).toHaveLength(1);
  });

  it('saveSessionOutput() saves an adapter’s snapshots without touching the model’s history', async () => {
    const { harness } = setup();
    const storage = createInMemoryStorage();
    const h = harness({
      storage,
      interactive: true,
    });
    const saved = await h.saveSessionOutput(
      [
        {
          id: 'plan-1',
          type: 'acp:plan',
          entries: 2,
        },
      ],
      THREAD,
    );
    expect(saved).toEqual([
      {
        id: 'plan-1',
        type: 'acp:plan',
        entries: 2,
      },
    ]);
    await h.execute('hi', THREAD);
    const response = await h.getAgentResponse(THREAD);
    expect(response.items.some((item) => frameworkCast<string>(item.type) === 'acp:plan')).toBe(
      false,
    );
    expect((await h.getSessionOutput(THREAD)).map((item) => item.type)).toEqual([
      'acp:plan',
      'message',
      'message',
    ]);

    const refused = await h
      .saveSessionOutput(
        [
          'not a snapshot',
        ],
        THREAD,
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert(refused instanceof OutputStoreError);
    await h.close();
  });
});

describe('a harness that is not interactive', () => {
  it('records nothing, and leaves a host-built context as it was', async () => {
    const { harness } = setup();
    const storage = createInMemoryStorage();
    const h = harness({
      storage,
    });
    expect(h.interactive).toBe(false);
    await h.execute('hi', THREAD);
    await h.getAgentResponse(THREAD);
    expect(await h.getSessionOutput(THREAD)).toEqual([]);
    expect(await storage.list('output:')).toEqual([]);

    const ctx = h.createContext();
    expect(ctx.threadId).not.toBe(ctx.id);
    expect('_broadcaster' in ctx && ctx._broadcaster).toBeFalsy();
    await h.close();
  });
});
