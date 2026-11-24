// Stand-ins for the Cloudflare bindings the package takes, each over a real SQLite
// database (`bun:sqlite`) or plain memory, plus the flow the wake presets are run on.

import { Database } from 'bun:sqlite';
import type {
  CallModelRequest,
  ContextData,
  LLMResponse,
  StorageAdapter,
} from '@noetic-tools/core';
import { AgentHarness, callModel, defineSource, runCode, step } from '@noetic-tools/core';
import { z } from 'zod';
import type { AlarmStorageLike } from '../src/alarm-wake';
import type { D1DatabaseLike, D1StatementLike } from '../src/d1-storage';
import type { DurableObjectSqlLike } from '../src/durable-object-storage';
import type {
  TurnParams,
  WorkflowBindingLike,
  WorkflowInstanceLike,
  WorkflowStepLike,
} from '../src/workflow-turn';

//#region Bindings

/** A D1 binding over a SQLite database. `failing` makes every statement reject. */
export function fakeD1(
  db: Database = new Database(':memory:'),
  state: {
    failing?: boolean;
  } = {},
): D1DatabaseLike {
  function statement(query: string, values: string[]): D1StatementLike {
    const refuse = (): void => {
      if (state.failing) {
        throw new Error('D1_ERROR: storage is unavailable');
      }
    };
    return {
      bind: (...bound) => statement(query, bound),
      first: async () => {
        refuse();
        return db.query(query).get(...values);
      },
      all: async () => {
        refuse();
        return {
          results: db.query(query).all(...values),
        };
      },
      run: async () => {
        refuse();
        return {
          meta: {
            changes: db.query(query).run(...values).changes,
          },
        };
      },
    };
  }
  return {
    prepare: (query) => statement(query, []),
  };
}

/** A Durable Object's `ctx.storage.sql` over a SQLite database. */
export function fakeObjectSql(db: Database = new Database(':memory:')): DurableObjectSqlLike {
  return {
    exec: (query, ...bindings) => {
      const rows = db.query(query).all(...bindings);
      return {
        toArray: () => rows,
      };
    },
  };
}

/** A Durable Object's alarm: the one time it is set to, or undefined. */
export interface FakeAlarm extends AlarmStorageLike {
  at: number | undefined;
}

export function fakeAlarm(): FakeAlarm {
  const alarm: FakeAlarm = {
    at: undefined,
    setAlarm: (scheduledTime) => {
      alarm.at = scheduledTime;
    },
    deleteAlarm: () => {
      alarm.at = undefined;
    },
  };
  return alarm;
}

/**
 * One Workflow instance's durable state: the result of every step that finished,
 * and the events sent to it. A `step` made over it replays as Workflows does.
 */
export interface FakeInstance {
  done: Map<string, unknown>;
  ran: string[];
  waits: Array<{
    name: string;
    timeout?: number | string;
  }>;
  /** Events sent and not yet taken by a wait. */
  events: number;
  /** Ends the wait in flight: with the event, or by timing out. */
  send(): void;
  expire(): void;
  step(): WorkflowStepLike;
}

export function fakeInstance(): FakeInstance {
  let waiting:
    | {
        name: string;
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  const instance: FakeInstance = {
    done: new Map(),
    ran: [],
    waits: [],
    events: 0,
    send: () => {
      if (!waiting) {
        instance.events += 1;
        return;
      }
      instance.done.set(waiting.name, 'event');
      waiting.resolve({});
      waiting = undefined;
    },
    expire: () => {
      if (!waiting) {
        throw new Error('no wait is in flight');
      }
      instance.done.set(waiting.name, 'timeout');
      waiting.reject(new Error('waitForEvent timed out'));
      waiting = undefined;
    },
    step: () => ({
      do: async <T>(name: string, callback: () => Promise<T>): Promise<T> => {
        if (instance.done.has(name)) {
          // @ts-expect-error — a recorded step result is what the callback returned
          return instance.done.get(name);
        }
        instance.ran.push(name);
        const result = await callback();
        instance.done.set(name, structuredClone(result));
        return result;
      },
      waitForEvent: (name, options) => {
        const ended = instance.done.get(name);
        if (ended === 'event') {
          return Promise.resolve({});
        }
        if (ended === 'timeout') {
          return Promise.reject(new Error('waitForEvent timed out'));
        }
        instance.waits.push({
          name,
          timeout: options.timeout,
        });
        if (instance.events > 0) {
          instance.events -= 1;
          instance.done.set(name, 'event');
          return Promise.resolve({});
        }
        return new Promise((resolve, reject) => {
          waiting = {
            name,
            resolve,
            reject,
          };
        });
      },
    }),
  };
  return instance;
}

/** A Workflow binding that keeps the instances made through it. */
export interface FakeBinding extends WorkflowBindingLike<TurnParams> {
  created: Map<string, TurnParams>;
  sent: Array<{
    id: string;
    type: string;
  }>;
}

export function fakeBinding(): FakeBinding {
  const created = new Map<string, TurnParams>();
  const sent: FakeBinding['sent'] = [];
  const instanceOf = (id: string): WorkflowInstanceLike => ({
    sendEvent: async (event) => {
      sent.push({
        id,
        type: event.type,
      });
    },
  });
  return {
    created,
    sent,
    create: async ({ id, params }) => {
      if (created.has(id)) {
        throw new Error(`(instance.already_exists) instance ${id} already exists`);
      }
      created.set(id, params);
      return instanceOf(id);
    },
    get: async (id) => {
      if (!created.has(id)) {
        throw new Error(`(instance.not_found) instance ${id} does not exist`);
      }
      return instanceOf(id);
    },
  };
}

//#endregion

//#region The flow

export const HOUR = 36e5;
export const DAY = 24 * HOUR;

export interface Model {
  calls: number;
  call: (request: CallModelRequest) => Promise<LLMResponse>;
}

/** Answers `<tag>-<n>`. */
export function model(tag: string): Model {
  const m: Model = {
    calls: 0,
    call: async () => {
      m.calls += 1;
      return {
        items: [
          {
            id: `msg-${crypto.randomUUID()}`,
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: `${tag}-${m.calls}`,
              },
            ],
          },
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

/** Replies that live outside any harness, as an upstream system's would. */
export type Mailbox = string[];

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
          await new Promise((resolve) => setTimeout(resolve, 2));
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

const turn = (id: string) =>
  callModel<ContextData, string, string>({
    id,
    model: 'test/model',
  });

const waitForReply = step.wait({
  id: 'wait',
  connection: 'inbox',
  event: 'reply',
  timeoutMs: DAY,
});

const WaitedSchema = z.object({
  event: z.object({
    payload: z.object({
      text: z.string(),
    }),
  }),
});

/** Plan, wait up to a day for a person's reply, then answer with it. */
const flow = runCode<ContextData, string, string>({
  id: 'flow',
  execute: async (input, execCtx) => {
    await execCtx.harness.run(turn('plan'), input, execCtx);
    const waited = WaitedSchema.parse(await execCtx.harness.run(waitForReply, undefined, execCtx));
    return String(await execCtx.harness.run(turn('answer'), waited.event.payload.text, execCtx));
  },
});

export interface Clock {
  t: number;
}

/** A harness as a Worker builds one per request: nothing shared but storage. */
export function harnessOver(opts: {
  storage: StorageAdapter;
  m: Model;
  mailbox: Mailbox;
  clock: Clock;
}): AgentHarness {
  return new AgentHarness({
    name: 'worker',
    params: {},
    agentGraph: flow,
    now: () => opts.clock.t,
    connections: {
      inbox: inbox(opts.mailbox),
    },
    environment: {
      storage: {
        adapter: opts.storage,
        lease: {
          waitMs: 0,
        },
        park: {
          graceMs: 0,
          autoWake: false,
        },
      },
    },
    _testCallModel: (request) => opts.m.call(request),
  });
}

//#endregion
