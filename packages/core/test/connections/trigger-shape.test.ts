import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type {
  Connection,
  ConnectionEventInfo,
  ConnectionProvider,
  ConnectionTrigger,
} from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import { createConnectionRuntime } from '../../src/connections/registry';
import { defineSource } from '../../src/connections/sources';
import { checkTrigger } from '../../src/connections/trigger-shape';
import { TriggerRunner } from '../../src/connections/triggers';
import { createInMemoryStorage } from '../../src/index';
import { createInMemoryArtifactStore } from '../../src/runtime/in-memory-artifact-store';

const received: ConnectionEventInfo = {
  name: 'email.received',
  replay: 'none',
  argumentsSchema: {
    type: 'object',
    properties: {
      folder: {
        type: 'string',
        enum: [
          'inbox',
          'archive',
        ],
      },
    },
    additionalProperties: false,
  },
  payloadSchema: {
    type: 'object',
    properties: {
      from: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
          },
        },
        required: [
          'address',
        ],
      },
      subject: {
        type: 'string',
      },
      size: {
        type: 'integer',
      },
      labels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
            },
          },
        },
      },
      headers: {
        type: 'object',
        additionalProperties: {
          type: 'string',
        },
      },
    },
    required: [
      'from',
      'size',
    ],
  },
};

function trigger(fields: Partial<ConnectionTrigger>): ConnectionTrigger {
  return {
    id: 'mail',
    connection: 'inbox',
    event: 'email.received',
    input: 'event.id',
    ...fields,
  };
}

/** Waits until an error that says `text` is reported, or two seconds have passed. */
async function reported(errors: ReadonlyArray<string>, text: string): Promise<void> {
  const deadline = Date.now() + 2e3;
  while (!errors.some((error) => error.includes(text)) && Date.now() < deadline) {
    await Bun.sleep(1);
  }
  expect(errors.join('\n')).toContain(text);
}

/** The config error `work` throws. */
function refusal(work: () => unknown): NoeticConfigError {
  try {
    work();
  } catch (e) {
    if (e instanceof NoeticConfigError) {
      return e;
    }
    throw e;
  }
  throw new Error('expected a config error');
}

describe('checkTrigger', () => {
  test('accepts a trigger that fits the event, and an event that says nothing about itself', () => {
    const check = checkTrigger(
      trigger({
        arguments: {
          folder: 'inbox',
        },
        filter: '$contains(event.payload.from.address, "@vendor.example")',
        input:
          'event.payload.subject & event.payload.labels.name & event.payload.headers.anything & event.payload.labels@$l.from[address = $l.name].address',
        thread: 'event.id',
        payload: z.object({
          from: z.object({
            address: z.string(),
          }),
          size: z.number(),
          subject: z.string().optional(),
        }),
      }),
      received,
    );
    expect(
      check({
        from: {
          address: 'a@vendor.example',
        },
        size: 3,
      }),
    ).toBeUndefined();
    const silent = checkTrigger(
      trigger({
        arguments: {
          anything: 1,
        },
        input: 'event.payload.whatever',
      }),
      {
        name: 'email.received',
        replay: 'none',
      },
    );
    expect(silent(42)).toBeUndefined();
  });

  test('refuses arguments the event does not accept', () => {
    const error = refusal(() =>
      checkTrigger(
        trigger({
          arguments: {
            folder: 'spam',
          },
        }),
        received,
      ),
    );
    expect(error.code).toBe('CONNECTION_INVALID');
    expect(error.message).toContain("gives arguments that event 'email.received'");
    expect(error.message).toContain('folder');
  });

  test('refuses an expression that reads a field the event does not declare', () => {
    for (const [field, source, missing] of [
      [
        'filter',
        'event.payload.sender = "a"',
        'event.payload.sender',
      ],
      [
        'input',
        'event.payload.from.name',
        'event.payload.from.name',
      ],
      [
        'thread',
        '$string(event.payload.labels[name = "x"].colour)',
        'event.payload.labels.colour',
      ],
    ] as const) {
      const error = refusal(() =>
        checkTrigger(
          trigger({
            [field]: source,
          }),
          received,
        ),
      );
      expect(error.code).toBe('CONNECTION_INVALID');
      expect(error.message).toContain(`reads '${missing}' in its ${field}`);
    }
  });

  test('refuses an expected payload the event does not give', () => {
    const cases: Array<
      [
        ConnectionTrigger['payload'],
        string,
      ]
    > = [
      [
        z.object({
          sender: z.string(),
        }),
        'payload.sender is not declared',
      ],
      [
        z.object({
          subject: z.string(),
        }),
        'payload.subject is optional there and required here',
      ],
      [
        z.object({
          size: z.string(),
        }),
        'payload.size is integer, not string',
      ],
      [
        {
          type: 'object',
          properties: {
            labels: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          },
        },
        'payload.labels[] is object, not string',
      ],
      [
        {
          type: 'array',
        },
        'payload is object, not array',
      ],
    ];
    for (const [payload, problem] of cases) {
      const error = refusal(() =>
        checkTrigger(
          trigger({
            payload,
          }),
          received,
        ),
      );
      expect(error.code).toBe('CONNECTION_INVALID');
      expect(error.message).toContain(problem);
    }
  });

  test("refuses a trigger's own payload schema that does not load", () => {
    const error = refusal(() =>
      checkTrigger(
        trigger({
          payload: {
            type: 'no-such-type',
          },
        }),
        received,
      ),
    );
    expect(error.code).toBe('CONNECTION_INVALID');
    expect(error.message).toContain("payload schema of trigger 'mail' does not load");
  });

  test("leaves unchecked an event's schema it cannot read", () => {
    const odd = {
      type: 'no-such-type',
    };
    const check = checkTrigger(
      trigger({
        arguments: {
          folder: 'spam',
        },
        filter: 'event.payload.anything = 1',
      }),
      {
        ...received,
        argumentsSchema: odd,
        payloadSchema: odd,
      },
    );
    expect(check('anything')).toBeUndefined();
  });

  test('skips an object that says more fields may come', () => {
    for (const open of [
      {
        additionalProperties: true,
      },
      {
        patternProperties: {
          '^x-': {},
        },
      },
      {
        allOf: [
          {},
        ],
      },
    ]) {
      checkTrigger(
        trigger({
          filter: 'event.payload.undeclared = 1',
          payload: z.object({
            undeclared: z.number(),
          }),
        }),
        {
          ...received,
          payloadSchema: {
            type: 'object',
            properties: {
              subject: {
                type: 'string',
              },
            },
            ...open,
          },
        },
      );
    }
  });

  test("holds a payload to the trigger's schema, not the event's", () => {
    const check = checkTrigger(
      trigger({
        payload: z.object({
          size: z.number().max(10),
        }),
      }),
      received,
    );
    // The event declares `from` as required; the trigger does not ask for it.
    expect(
      check({
        size: 3,
      }),
    ).toBeUndefined();
    expect(
      check({
        size: 10,
      }),
    ).toBeUndefined();
    expect(
      check({
        size: 11,
      }),
    ).toContain("does not match what trigger 'mail' expects: size");
  });
});

describe('a trigger checked by its runner', () => {
  const events = {
    received: z.object({
      folder: z.string(),
      size: z.number(),
    }),
  };

  async function rig(fields: Partial<ConnectionTrigger>) {
    const storage = createInMemoryStorage();
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
    const delivered: string[] = [];
    const runner = new TriggerRunner({
      runtime,
      storage,
      triggers: [
        {
          id: 'inbox',
          connection: 'mail',
          event: 'received',
          input: 'event.id',
          ...fields,
        },
      ],
      deliver: async (delivery) => {
        delivered.push(delivery.event.id);
      },
      relistenDelayMs: () => 0,
      onError: () => {},
    });
    await runtime.start();
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

  test('does not start when the trigger reads a field the source does not emit', async () => {
    const { runner, close } = await rig({
      filter: 'event.payload.mailbox = "inbox"',
    });
    const error = await runner.start().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NoeticConfigError);
    expect(error instanceof NoeticConfigError && error.code).toBe('CONNECTION_INVALID');
    await expect(
      runner.add({
        id: 'later',
        connection: 'mail',
        event: 'received',
        input: 'event.payload.subject',
      }),
    ).rejects.toThrow("reads 'event.payload.subject' in its input");
    await close();
  });

  test('checks a trigger whose connection connects late before it reads an event', async () => {
    const storage = createInMemoryStorage();
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
    const errors: string[] = [];
    const runner = new TriggerRunner({
      runtime,
      storage,
      triggers: [
        {
          id: 'inbox',
          connection: 'mail',
          event: 'received',
          input: 'event.id',
          filter: 'event.payload.mailbox = "inbox"',
        },
      ],
      deliver: async () => {},
      relistenDelayMs: () => 5,
      onError: (_trigger, e) => {
        errors.push(e instanceof Error ? e.message : String(e));
      },
    });
    // The connection has not connected, so there is nothing yet to check against.
    await runner.start();
    await reported(errors, "reads 'event.payload.mailbox' in its filter");
    for (let sends = 0; sends < 4; sends++) {
      await source
        .emit({
          id: 'e1',
          type: 'received',
          payload: {
            folder: 'inbox',
            size: 1,
          },
        })
        .catch(() => {});
      await Bun.sleep(10);
    }
    expect(await runner.outcomes('inbox')).toEqual([]);
    expect(await storage.list('noetic/connections/triggers/inbox/')).toEqual([]);
    await runner.close();
    await runtime.close();
  });

  test('checks a trigger added under the id of one removed while its connection was connecting', async () => {
    const storage = createInMemoryStorage();
    const source = defineSource({
      events,
    });
    const connecting = Promise.withResolvers<void>();
    const dropped = Promise.withResolvers<{
      reason: string;
    }>();
    let connects = 0;
    const provider: ConnectionProvider = {
      ...source,
      async connect(options): Promise<ReadonlyArray<Connection>> {
        connects += 1;
        if (connects === 1) {
          await connecting.promise;
        }
        const first = connects === 1;
        const [connection] = await source.connect(options);
        assert(connection !== undefined);
        // Only the first connection drops; the one made after it stays.
        return first
          ? [
              {
                ...connection,
                closed: dropped.promise,
              },
            ]
          : [
              connection,
            ];
      },
    };
    const runtime = createConnectionRuntime({
      connections: {
        mail: provider,
      },
      storage,
      artifacts: createInMemoryArtifactStore(),
      reconnectDelayMs: () => 5,
    });
    const errors: string[] = [];
    const runner = new TriggerRunner({
      runtime,
      storage,
      triggers: [
        {
          id: 'inbox',
          connection: 'mail',
          event: 'received',
          input: 'event.id',
          payload: z.object({
            folder: z.literal('inbox'),
          }),
        },
      ],
      deliver: async () => {},
      relistenDelayMs: () => 5,
      onError: (_trigger, e) => {
        errors.push(e instanceof Error ? e.message : String(e));
      },
    });
    await runner.start();
    await Bun.sleep(5);
    // Its loop is waiting on the connection, and checks itself once that connects.
    const removed = runner.remove('inbox');
    await Bun.sleep(5);
    connecting.resolve();
    expect(await removed).toBe(true);
    dropped.resolve({
      reason: 'dropped',
    });
    await Bun.sleep(5);
    // Added while the connection is down: there is nothing to check it against yet.
    await runner.add({
      id: 'inbox',
      connection: 'mail',
      event: 'received',
      input: 'event.id',
      filter: 'event.payload.mailbox = "inbox"',
    });
    await reported(errors, "reads 'event.payload.mailbox' in its filter");
    expect(await runner.outcomes('inbox')).toEqual([]);
    await runner.close();
    await runtime.close();
  });

  test('keeps an event the trigger does not expect as a failed outcome, with no turn', async () => {
    const { source, runner, delivered, close } = await rig({
      payload: z.object({
        folder: z.literal('inbox'),
      }),
    });
    await runner.start();
    await source.emit({
      id: 'ok',
      type: 'received',
      payload: {
        folder: 'inbox',
        size: 1,
      },
    });
    // A payload of the wrong shape is wrong every time: it is recorded at once,
    // and the source is not asked to send it again.
    await source.emit({
      id: 'junk',
      type: 'received',
      payload: {
        folder: 'spam',
        size: 1,
      },
    });
    await runner.idle();
    expect(await runner.replay('inbox', 'junk')).toBe(false);
    expect(delivered).toEqual([
      'ok',
    ]);
    expect(await runner.outcomes('inbox')).toContainEqual(
      expect.objectContaining({
        eventId: 'junk',
        status: 'failed',
        error: expect.stringContaining("does not match what trigger 'inbox' expects: folder"),
      }),
    );
    await close();
  });
});
