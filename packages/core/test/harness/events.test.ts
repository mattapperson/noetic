// Event-driven work at the harness: an event delivered twice starts one turn, a
// message delivered again after its turn finished is answered from the record, and
// triggers can be added while the harness runs. See specs/35-connections § Triggers
// and specs/23a-step-level-resume § Sessions.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { CallModelRequest, ContextData, LLMResponse } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel } from '../../src/builders/step-builders';
import { defineSource } from '../../src/connections/sources';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { assistantMessage } from '../_helpers';

//#region Fixtures

interface Model {
  calls: number;
  call: (request: CallModelRequest) => Promise<LLMResponse>;
}

function model(tag: string): Model {
  const m: Model = {
    calls: 0,
    call: async () => {
      m.calls += 1;
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

const agent = callModel<ContextData, string, string>({
  id: 'agent',
  model: 'test/model',
});

function emails() {
  return defineSource({
    events: {
      received: z.object({
        from: z.string(),
        subject: z.string(),
      }),
    },
  });
}

async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 2e3; i += 1) {
    if (await done()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert(await done());
}

//#endregion

describe('an event delivered twice', () => {
  it('starts one turn', async () => {
    const m = model('a');
    const inbox = emails();
    const harness = new AgentHarness({
      name: 'events',
      params: {},
      agentGraph: agent,
      connections: {
        inbox,
      },
      triggers: [
        {
          id: 'vendor-mail',
          connection: 'inbox',
          event: 'received',
          filter: '$contains(event.payload.from, "@vendor.example")',
          input: '"Email from " & event.payload.from & ": " & event.payload.subject',
          thread: '"mail:" & event.id',
        },
      ],
      environment: {
        storage: {
          adapter: createInMemoryStorage(),
        },
      },
      _testCallModel: (request) => m.call(request),
    });
    await harness.start();
    const mail = {
      type: 'received' as const,
      id: 'msg-77',
      payload: {
        from: 'billing@vendor.example',
        subject: 'Invoice 1042',
      },
    };

    // The provider delivers the same email twice, as providers do.
    await inbox.emit(mail);
    await inbox.emit(mail);
    await until(() => m.calls >= 1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(m.calls).toBe(1);
    const response = await harness.getAgentResponse({
      threadId: 'mail:msg-77',
    });
    expect(response.text).toBe('a-1');
    await harness.close();
  });
});

describe('a message delivered again after its turn finished', () => {
  it('is answered with the recorded answer, and nothing runs', async () => {
    const m = model('a');
    const storage = createInMemoryStorage();
    const build = (): AgentHarness =>
      new AgentHarness({
        name: 'events',
        params: {},
        agentGraph: agent,
        environment: {
          storage: {
            adapter: storage,
          },
        },
        _testCallModel: (request) => m.call(request),
      });
    const delivery = {
      threadId: 't',
      messageId: 'webhook-9',
    };
    const first = build();
    await first.execute('create the case', delivery);
    expect((await first.getAgentResponse(delivery)).text).toBe('a-1');

    // The sender retries; a new process takes the retry.
    const second = build();
    const events = second.getFullStream(delivery)[Symbol.asyncIterator]();
    const firstEvent = events.next();
    await second.execute('create the case', delivery);
    const again = await second.getAgentResponse(delivery);
    // Nothing streams for it, so the event carries the answer for whoever posts it.
    expect((await firstEvent).value).toMatchObject({
      type: 'events:turn_replayed',
      data: {
        messageIds: [
          'webhook-9',
        ],
        text: 'a-1',
      },
    });
    await events.return?.();
    expect(again.replayed).toBe(true);
    expect(again.text).toBe('a-1');
    expect(m.calls).toBe(1);

    // A different message on the thread is a new turn.
    await second.execute('and close it', {
      threadId: 't',
      messageId: 'webhook-10',
    });
    const next = await second.getAgentResponse(delivery);
    expect(next.replayed).toBeUndefined();
    expect(next.text).toBe('a-2');
    expect(m.calls).toBe(2);
  });

  it('runs again when the message carries no id of its own', async () => {
    const m = model('a');
    const harness = new AgentHarness({
      name: 'events',
      params: {},
      agentGraph: agent,
      environment: {
        storage: {
          adapter: createInMemoryStorage(),
        },
      },
      _testCallModel: (request) => m.call(request),
    });
    const thread = {
      threadId: 't',
    };
    await harness.execute('hello', thread);
    await harness.getAgentResponse(thread);
    await harness.execute('hello', thread);
    await harness.getAgentResponse(thread);
    expect(m.calls).toBe(2);
  });
});

describe('triggers at the harness', () => {
  it('can be added and removed while it runs', async () => {
    const m = model('a');
    const inbox = emails();
    const harness = new AgentHarness({
      name: 'events',
      params: {},
      agentGraph: agent,
      connections: {
        inbox,
      },
      environment: {
        storage: {
          adapter: createInMemoryStorage(),
        },
      },
      _testCallModel: (request) => m.call(request),
    });
    expect(harness.listTriggers()).toEqual([]);
    await harness.addTrigger({
      id: 'all-mail',
      connection: 'inbox',
      event: 'received',
      input: 'event.payload.subject',
    });
    expect(harness.listTriggers().map((t) => t.id)).toEqual([
      'all-mail',
    ]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await inbox.emit({
      type: 'received',
      id: 'm-1',
      payload: {
        from: 'a@b.example',
        subject: 'Hello',
      },
    });
    await until(() => m.calls === 1);
    expect(await harness.removeTrigger('all-mail')).toBe(true);
    expect(harness.listTriggers()).toEqual([]);
    await harness.close();
  });
});

describe('a message delivered again while its turn is still running', () => {
  it('does not run as a second turn once the first ends', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage = createInMemoryStorage();
    const harness = new AgentHarness({
      name: 'events',
      params: {},
      agentGraph: agent,
      environment: {
        storage: {
          adapter: storage,
        },
      },
      _testCallModel: async () => {
        calls += 1;
        await gate;
        return {
          items: [
            assistantMessage(`answer-${calls}`),
          ],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    });
    const delivery = {
      threadId: 't',
      messageId: 'webhook-9',
    };
    await harness.execute('charge the card', delivery);
    await until(() => calls === 1);

    // The sender retries while the first delivery is still being worked on.
    await harness.execute('charge the card', delivery);
    await harness.execute('charge the card', delivery);
    release?.();
    const response = await harness.getAgentResponse({
      threadId: 't',
    });
    expect(response.text).toBe('answer-1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);

    // A different message on the thread still gets its own turn.
    await harness.execute('and email the receipt', {
      threadId: 't',
      messageId: 'webhook-10',
    });
    await until(() => calls === 2);
    await harness.close();
  });

  it('applies without storage too, to a message still queued', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = new AgentHarness({
      name: 'events',
      params: {},
      agentGraph: agent,
      _testCallModel: async () => {
        calls += 1;
        await gate;
        return {
          items: [
            assistantMessage(`answer-${calls}`),
          ],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    });
    await harness.execute('first', {
      threadId: 't',
      messageId: 'm-1',
    });
    await until(() => calls === 1);
    // m-2 waits its turn; delivered twice, it is queued once.
    const second = {
      threadId: 't',
      messageId: 'm-2',
    };
    await harness.execute('second', second);
    await harness.execute('second', second);
    release?.();
    await until(() => calls === 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(2);
    await harness.close();
  });
});

describe('a message delivered twice at the same instant', () => {
  it('runs once, with storage and without', async () => {
    for (const storage of [
      createInMemoryStorage(),
      undefined,
    ]) {
      const m = model('a');
      const harness = new AgentHarness({
        name: 'events',
        params: {},
        agentGraph: agent,
        ...(storage
          ? {
              environment: {
                storage: {
                  adapter: storage,
                },
              },
            }
          : {}),
        _testCallModel: (request) => m.call(request),
      });
      const delivery = {
        threadId: 't',
        messageId: 'webhook-9',
      };
      // Neither waits for the other: the second arrives before the first turn has
      // written anything down.
      await Promise.all([
        harness.execute('charge the card', delivery),
        harness.execute('charge the card', delivery),
      ]);
      const response = await harness.getAgentResponse({
        threadId: 't',
      });
      expect(response.text).toBe('a-1');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(m.calls).toBe(1);
      await harness.close();
    }
  });
});
