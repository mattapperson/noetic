// Custom items (spec 34): declared item shapes that stream events and a final item
// under one id, scoped to a workflow root or one step, and typed through the harness.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type {
  CustomItemOf,
  FromJsonSchema,
  Item,
  Step,
  StreamEvent,
  WorkflowDocument,
  WorkflowNode,
} from '@noetic-tools/types';
import {
  frameworkCast,
  isCustomItem,
  isCustomItemEvent,
  isNoeticConfigError,
  isNoeticError,
} from '@noetic-tools/types';
import { z } from 'zod';
import { customItem } from '../../src/builders/custom-item';
import { loop } from '../../src/builders/loop-builder';
import { runCode } from '../../src/builders/step-builders';
import { workflow } from '../../src/builders/workflow-step';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { until } from '../../src/until/predicates';

//#region Helpers

const progress = customItem({
  type: 'myapp:progress',
  description: 'How far a batch job has got.',
  event: z.object({
    done: z.number(),
  }),
  output: z.object({
    done: z.number(),
    of: z.number(),
  }),
});

const note = customItem({
  type: 'myapp:note',
  output: z.object({
    text: z.string(),
  }),
});

/** Runs `graph` on a harness built from it and collects every stream. */
async function runGraph<G extends Parameters<typeof graphHarness>[0]>(graph: G, input = 'go') {
  const harness = graphHarness(graph);
  const items: unknown[] = [];
  const events: StreamEvent[] = [];
  void collect(harness.getItemStream(), items);
  void collect(harness.getFullStream(), events);
  await harness.execute(input);
  const response = await harness.getAgentResponse();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return {
    items,
    events,
    response,
  };
}

async function collect<T>(stream: AsyncIterable<T>, into: T[]): Promise<void> {
  for await (const value of stream) {
    into.push(value);
  }
}

function graphHarness(graph: ConstructorParameters<typeof AgentHarness>[0]['agentGraph']) {
  return new AgentHarness({
    name: 'custom',
    params: {},
    agentGraph: graph,
  });
}

function ofType(values: ReadonlyArray<unknown>, type: string): Record<string, unknown>[] {
  return values.flatMap((value) =>
    typeof value === 'object' && value !== null && 'type' in value && value.type === type
      ? [
          frameworkCast<Record<string, unknown>>(value),
        ]
      : [],
  );
}

function rawEvents(events: StreamEvent[]): unknown[] {
  return events.filter((e) => e.type.endsWith(':custom_item_event')).map((e) => e.data);
}

async function expectConfigError(promise: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof promise === 'function' ? promise() : promise);
    expect.unreachable(`expected ${code}`);
  } catch (e) {
    // A config error thrown inside a runCode body (a workflow() step) arrives as the
    // root cause of that step's failure.
    const cause = rootCause(e);
    assert(isNoeticConfigError(cause), String(cause));
    expect(cause.code).toBe(code);
  }
}

function rootCause(error: unknown): unknown {
  let current = error;
  while (isNoeticError(current) && current.noeticError.kind === 'step_failed') {
    current = current.noeticError.cause;
  }
  return current;
}

function counter(emitItems: Parameters<typeof runCode>[0]['emitItems']) {
  return runCode<ContextData, string, string>({
    id: 'count',
    customItems: {
      progress,
    },
    emitItems,
    async *execute() {
      yield {
        done: 1,
      };
      yield {
        done: 2,
      };
      return 'counted';
    },
  });
}

//#endregion

//#region Tests

describe('customItem()', () => {
  it('takes Standard Schemas or JSON Schema', async () => {
    const fromJson = customItem({
      type: 'myapp:json',
      output: {
        type: 'object',
        properties: {
          n: {
            type: 'number',
          },
        },
        required: [
          'n',
        ],
      } as const,
    });
    expect(fromJson.type).toBe('myapp:json');
    expect(
      (
        await fromJson.output['~standard'].validate({
          n: 1,
        })
      ).issues,
    ).toBeUndefined();
    expect(
      (
        await fromJson.output['~standard'].validate({
          n: 'x',
        })
      ).issues,
    ).toBeDefined();
    expect(fromJson.event).toBeUndefined();
  });

  it('throws INVALID_CUSTOM_ITEM_TYPE without a prefix', async () => {
    await expectConfigError(
      () =>
        customItem({
          type: frameworkCast<'a:b'>('progress'),
          output: z.object({}),
        }),
      'INVALID_CUSTOM_ITEM_TYPE',
    );
  });

  it('throws INVALID_CUSTOM_ITEM_SHAPE for a non-object output or a reserved field', async () => {
    await expectConfigError(
      () =>
        customItem({
          type: 'myapp:bad',
          output: z.string(),
        }),
      'INVALID_CUSTOM_ITEM_SHAPE',
    );
    for (const key of [
      'id',
      'type',
    ]) {
      await expectConfigError(
        () =>
          customItem({
            type: 'myapp:bad',
            output: {
              type: 'object',
              properties: {
                [key]: {
                  type: 'string',
                },
              },
            },
          }),
        'INVALID_CUSTOM_ITEM_SHAPE',
      );
    }
  });
});

describe('emitting from programmatic steps', () => {
  it('a generator runCode streams events, then onDone gives the final item, under one id', async () => {
    const { items, events, response } = await runGraph(
      counter({
        item: 'progress',
        onDone: () => ({
          done: 2,
          of: 2,
        }),
      }),
    );
    const streamed = ofType(items, 'myapp:progress');
    expect(streamed.map((entry) => entry.isComplete)).toEqual([
      false,
      false,
      true,
    ]);
    expect(streamed.map((entry) => entry.event)).toEqual([
      {
        done: 1,
      },
      {
        done: 2,
      },
      undefined,
    ]);
    const ids = new Set(streamed.map((entry) => entry.id));
    expect(ids.size).toBe(1);
    expect(rawEvents(events)).toHaveLength(2);
    const finals = ofType(response.items, 'myapp:progress');
    expect(finals).toEqual([
      {
        done: 2,
        of: 2,
        id: [
          ...ids,
        ][0],
        type: 'myapp:progress',
      },
    ]);
  });

  it('onStart and onDone hooks may be generators, async, or plain', async () => {
    const step = runCode<ContextData, string, string>({
      id: 'hooks',
      customItems: {
        progress,
      },
      emitItems: {
        item: 'progress',
        *onStart() {
          yield {
            done: 0,
          };
          return undefined;
        },
        async *onDone() {
          yield {
            done: 1,
          };
          return {
            done: 1,
            of: 1,
          };
        },
      },
      execute: async () => 'ok',
    });
    const { items } = await runGraph(step);
    expect(ofType(items, 'myapp:progress').map((entry) => entry.event ?? entry.of)).toEqual([
      {
        done: 0,
      },
      {
        done: 1,
      },
      1,
    ]);
  });

  it('a dispatch that never returns a final item stays stream-only', async () => {
    const { items, response } = await runGraph(
      counter({
        item: 'progress',
      }),
    );
    expect(ofType(items, 'myapp:progress')).toHaveLength(2);
    expect(ofType(response.items, 'myapp:progress')).toEqual([]);
  });

  it('emitItems true makes an output whose type names a custom item that item', async () => {
    const step = runCode<ContextData, string, unknown>({
      id: 'note',
      customItems: {
        note,
      },
      emitItems: true,
      execute: async () => ({
        type: 'myapp:note',
        text: 'hi',
      }),
    });
    const { response } = await runGraph(frameworkCast<Step<ContextData, string, string>>(step));
    const [final] = ofType(response.items, 'myapp:note');
    assert(final);
    expect(final.text).toBe('hi');
    expect(typeof final.id).toBe('string');
  });

  it('throws INVALID_CUSTOM_ITEM when an event or final fails its schema', async () => {
    const harness = graphHarness(undefined);
    const badEvent = runCode<ContextData, string, string>({
      id: 'bad-event',
      customItems: {
        progress,
      },
      emitItems: {
        item: 'progress',
      },
      async *execute() {
        yield frameworkCast<{
          done: number;
        }>({
          done: 'x',
        });
        return 'x';
      },
    });
    await expectConfigError(
      harness.run(badEvent, '', harness.createContext()),
      'INVALID_CUSTOM_ITEM',
    );
    const badFinal = runCode<ContextData, string, string>({
      id: 'bad-final',
      customItems: {
        progress,
      },
      emitItems: {
        item: 'progress',
        onDone: () =>
          frameworkCast<{
            done: number;
            of: number;
          }>({
            done: 1,
          }),
      },
      execute: async () => 'x',
    });
    await expectConfigError(
      harness.run(badFinal, '', harness.createContext()),
      'INVALID_CUSTOM_ITEM',
    );
  });

  it('throws CUSTOM_ITEM_ALREADY_FINAL when both hooks give a final item', async () => {
    const harness = graphHarness(undefined);
    const final = () => ({
      done: 1,
      of: 1,
    });
    const step = runCode<ContextData, string, string>({
      id: 'twice',
      customItems: {
        progress,
      },
      emitItems: {
        item: 'progress',
        onStart: final,
        onDone: final,
      },
      execute: async () => 'x',
    });
    await expectConfigError(
      harness.run(step, '', harness.createContext()),
      'CUSTOM_ITEM_ALREADY_FINAL',
    );
  });

  it('throws CUSTOM_ITEM_HAS_NO_EVENTS for a yield with no item, or an item without events', async () => {
    await expectConfigError(
      () =>
        runCode<ContextData, string, string>({
          id: 'no-item',
          async *execute() {
            yield 1;
            return 'x';
          },
        }),
      'CUSTOM_ITEM_HAS_NO_EVENTS',
    );
    await expectConfigError(
      () =>
        runCode<ContextData, string, string>({
          id: 'no-events',
          customItems: {
            note,
          },
          emitItems: {
            item: 'note',
          },
          async *execute() {
            yield 1;
            return 'x';
          },
        }),
      'CUSTOM_ITEM_HAS_NO_EVENTS',
    );
    const harness = graphHarness(undefined);
    const plain = runCode<ContextData, string, string>({
      id: 'plain-yield',
      emitItems: {
        onDone: frameworkCast<() => string>(function* () {
          yield 1;
        }),
      },
      execute: async () => 'x',
    });
    await expectConfigError(
      harness.run(plain, '', harness.createContext()),
      'CUSTOM_ITEM_HAS_NO_EVENTS',
    );
  });

  it('throws UNKNOWN_CUSTOM_ITEM when a step names an item it does not declare', async () => {
    await expectConfigError(
      () =>
        runCode<ContextData, string, string>({
          id: 'unknown',
          emitItems: frameworkCast({
            item: 'progress',
          }),
          execute: async () => 'x',
        }),
      'UNKNOWN_CUSTOM_ITEM',
    );
  });
});

describe('custom items in JSON workflows', () => {
  const ROOT_ITEMS = {
    progress: {
      type: 'myapp:progress',
      event: {
        type: 'object',
        properties: {
          done: {
            type: 'number',
          },
        },
        required: [
          'done',
        ],
      },
      output: {
        type: 'object',
        properties: {
          done: {
            type: 'number',
          },
          of: {
            type: 'number',
          },
        },
        required: [
          'done',
          'of',
        ],
      },
    },
  } as const;

  function doc(root: WorkflowNode, customItems: WorkflowDocument['customItems'] = ROOT_ITEMS) {
    return frameworkCast<WorkflowDocument>({
      version: 1,
      customItems,
      root,
    });
  }

  it('onStart gives an event and onDone the final item, on every loop iteration', async () => {
    const { items, response } = await runGraph(
      workflow({
        id: 'flow',
        document: doc({
          kind: 'sequence',
          id: 'main',
          steps: [
            {
              kind: 'compute',
              id: 'seed',
              expr: "{ 'n': 3 }",
            },
            {
              kind: 'loop',
              id: 'work',
              maxIterations: 'infinity',
              body: {
                kind: 'compute',
                id: 'tick',
                expr: "{ 'n': n - 1 }",
                emitItems: {
                  item: 'progress',
                  onStart: "{ 'done': 3 - n }",
                  onDone: "{ 'done': 3 - n, 'of': 3 }",
                },
              },
              until: {
                kind: 'expr',
                expr: 'n = 0',
              },
            },
          ],
        }),
      }),
    );
    const streamed = ofType(items, 'myapp:progress');
    expect(streamed.map((entry) => entry.isComplete)).toEqual([
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(ofType(response.items, 'myapp:progress').map((entry) => entry.done)).toEqual([
      1,
      2,
      3,
    ]);
    expect(streamed[0]?.id).toBe(streamed[1]?.id);
    expect(streamed[0]?.id).not.toBe(streamed[2]?.id);
  });

  it("a node-level item is only that node's to emit", async () => {
    const owner: WorkflowNode = {
      kind: 'compute',
      id: 'owner',
      expr: "{ 'text': 'mine' }",
      customItems: {
        note: {
          type: 'myapp:note',
          output: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
              },
            },
            required: [
              'text',
            ],
          },
        },
      },
      emitItems: {
        item: 'note',
        onDone: "{ 'text': text }",
      },
    };
    const { response } = await runGraph(
      workflow({
        id: 'flow',
        document: doc(owner),
      }),
    );
    expect(ofType(response.items, 'myapp:note')).toHaveLength(1);
    const sibling = workflow({
      id: 'flow',
      document: doc({
        kind: 'sequence',
        id: 'seq',
        steps: [
          owner,
          {
            kind: 'compute',
            id: 'sibling',
            expr: "{ 'text': 'not mine' }",
            emitItems: {
              item: 'note',
              onDone: "{ 'text': text }",
            },
          },
        ],
      }),
    });
    const harness = graphHarness(sibling);
    await expectConfigError(
      harness.run(sibling, 'go', harness.createContext()),
      'UNKNOWN_CUSTOM_ITEM',
    );
  });

  it('an inline subflow sees the enclosing root items', async () => {
    const { response } = await runGraph(
      workflow({
        id: 'flow',
        document: doc({
          kind: 'subflow',
          id: 'inner',
          document: {
            version: 1,
            root: {
              kind: 'compute',
              id: 'leaf',
              expr: "{ 'done': 1, 'of': 1 }",
              emitItems: {
                item: 'progress',
                onDone: '$',
              },
            },
          },
        }),
      }),
    );
    expect(ofType(response.items, 'myapp:progress')).toHaveLength(1);
  });

  it('workflow() customItems validate and type the document items they agree with', async () => {
    const flow = workflow({
      id: 'flow',
      document: doc({
        kind: 'compute',
        id: 'c',
        expr: "{ 'type': 'myapp:progress', 'done': 1, 'of': 2 }",
        emitItems: true,
      }),
      customItems: {
        progress,
      },
    });
    const { response } = await runGraph(flow);
    expect(ofType(response.items, 'myapp:progress')).toHaveLength(1);
    await expectConfigError(async () => {
      const mismatched = workflow({
        id: 'flow',
        document: doc({
          kind: 'compute',
          id: 'c',
          expr: '1',
        }),
        customItems: {
          progress: note,
        },
      });
      const harness = graphHarness(mismatched);
      await harness.run(mismatched, 'go', harness.createContext());
    }, 'CUSTOM_ITEM_MISMATCH');
  });
});

describe('custom items on resume', () => {
  it('a final custom item survives a crash and replays quietly or streamed', async () => {
    const storage = createInMemoryStorage();
    let crash = true;
    const graph = () =>
      loop<ContextData, string, string>({
        id: 'flow',
        steps: [
          frameworkCast<Step<ContextData, string, string>>(
            runCode<ContextData, string, unknown>({
              id: 'note',
              customItems: {
                note,
              },
              emitItems: true,
              execute: async () => ({
                type: 'myapp:note',
                text: 'kept',
              }),
            }),
          ),
          runCode<ContextData, string, string>({
            id: 'gate',
            execute: async () => {
              if (crash) {
                throw new Error('host died');
              }
              return 'done';
            },
          }),
        ],
        until: until.maxSteps(1),
      });
    const durable = (emitItemsOnReplay?: boolean) =>
      new AgentHarness({
        name: 'custom-resume',
        params: {},
        emitItemsOnReplay,
        agentGraph: graph(),
        environment: {
          storage: {
            adapter: storage,
            checkpointStore: createCheckpointStore({
              storage,
            }),
          },
        },
      });
    const first = durable();
    const ctx = first.createContext();
    await expect(first.run(graph(), 'go', ctx)).rejects.toThrow('host died');
    crash = false;
    const second = durable(true);
    const resumed = await second.restore(ctx.id);
    assert(resumed);
    const streamed: Item[] = [];
    frameworkCast<{
      _broadcaster: unknown;
    }>(resumed)._broadcaster = {
      emit: (event: StreamEvent) => {
        if (event.type.endsWith(':item_appended')) {
          streamed.push(frameworkCast<Item>(event.data.item));
        }
      },
    };
    await second.run(graph(), 'go', resumed);
    expect(ofType(resumed.itemLog.items, 'myapp:note')).toHaveLength(1);
    expect(ofType(streamed, 'myapp:note')).toHaveLength(1);
  });
});

describe('custom items from a step outside agentGraph', () => {
  const noteStep = runCode<ContextData, string, unknown>({
    id: 'note',
    customItems: {
      note,
    },
    emitItems: true,
    execute: async () => ({
      type: 'myapp:note',
      text: 'kept',
    }),
  });

  function durable(storage: ReturnType<typeof createInMemoryStorage>) {
    return new AgentHarness({
      name: 'outside-graph',
      params: {},
      environment: {
        storage: {
          adapter: storage,
          checkpointStore: createCheckpointStore({
            storage,
          }),
        },
      },
    });
  }

  it('a new harness restores a log that holds them, before the step runs again', async () => {
    const storage = createInMemoryStorage();
    const first = durable(storage);
    const ctx = first.createContext();
    await first.run(frameworkCast<Step>(noteStep), 'go', ctx);
    const restored = await durable(storage).restore(ctx.id);
    assert(restored);
    expect(ofType(restored.itemLog.items, 'myapp:note')).toHaveLength(1);
  });

  it('a retried run rebuilds its log from storage with them in it', async () => {
    const storage = createInMemoryStorage();
    const harness = durable(storage);
    const ctx = harness.createContext();
    await harness.run(frameworkCast<Step>(noteStep), 'go', ctx);
    let fail = true;
    const flaky = runCode<ContextData, string, string>({
      id: 'flaky',
      execute: async () => {
        if (fail) {
          throw new Error('flaky');
        }
        return 'ok';
      },
    });
    await expect(harness.run(flaky, 'go', ctx)).rejects.toThrow('flaky');
    fail = false;
    expect(await harness.run(flaky, 'go', ctx)).toBe('ok');
    expect(ofType(ctx.itemLog.items, 'myapp:note')).toHaveLength(1);
  });
});

describe('typed results', () => {
  it('narrows harness results to the declared items', () => {
    const flow = workflow({
      id: 'flow',
      document: {
        version: 1,
        customItems: {
          tick: {
            type: 'myapp:tick',
            output: {
              type: 'object',
              properties: {
                n: {
                  type: 'number',
                },
              },
              required: [
                'n',
              ],
            },
          },
        },
        root: {
          kind: 'compute',
          id: 'c',
          expr: 'n',
        },
      },
      customItems: {
        progress,
      },
    });
    const harness = new AgentHarness({
      name: 'typed',
      params: {},
      agentGraph: flow,
    });
    type ResponseItem = Awaited<ReturnType<typeof harness.getAgentResponse>>['items'][number];
    type Progress = Extract<
      ResponseItem,
      {
        type: 'myapp:progress';
      }
    >;
    type Tick = Extract<
      ResponseItem,
      {
        type: 'myapp:tick';
      }
    >;
    const p: Progress = {
      id: 'x',
      type: 'myapp:progress',
      done: 1,
      of: 2,
    };
    const t: Tick = {
      id: 'y',
      type: 'myapp:tick',
      n: 1,
    };
    // @ts-expect-error: a progress item needs `of`.
    const missing: Progress = {
      id: 'x',
      type: 'myapp:progress',
      done: 1,
    };
    expect([
      p.of,
      t.n,
      missing.done,
    ]).toEqual([
      2,
      1,
      1,
    ]);
  });

  it('isCustomItem and isCustomItemEvent narrow results to one declared item', async () => {
    const { items, events, response } = await runGraph(
      counter({
        item: 'progress',
        onDone: () => ({
          done: 2,
          of: 2,
        }),
      }),
    );
    const typed = new AgentHarness({
      name: 'typed',
      params: {},
      agentGraph: runCode<
        ContextData,
        string,
        string,
        {
          progress: typeof progress;
        }
      >({
        id: 'typed',
        customItems: {
          progress,
        },
        execute: async () => 'x',
      }),
    });
    type Streamed =
      ReturnType<typeof typed.getItemStream> extends AsyncIterable<infer V> ? V : never;
    const progressEntries = frameworkCast<Streamed[]>(items).filter((item) =>
      isCustomItem(item, progress),
    );
    const seen = progressEntries.map((item) => (item.isComplete ? item.of : item.event.done));
    expect(seen).toEqual([
      1,
      2,
      2,
    ]);
    expect(response.items.filter((item) => isCustomItem(item, progress))).toHaveLength(1);
    expect(response.items.filter((item) => isCustomItem(item, note))).toHaveLength(0);
    const raw = events.filter((event) => isCustomItemEvent(event, progress));
    expect(raw.map((event) => event.data.event.done)).toEqual([
      1,
      2,
    ]);
    expect(isCustomItem(null, progress)).toBe(false);
    expect(
      isCustomItemEvent(
        {
          source: 'framework',
          type: 'a:custom_item_event',
          data: null,
        },
        progress,
      ),
    ).toBe(false);
  });

  it("keeps today's types when the graph declares nothing", () => {
    const harness = new AgentHarness({
      name: 'plain',
      params: {},
      agentGraph: runCode<ContextData, string, string>({
        id: 'x',
        execute: async () => 'x',
      }),
    });
    type ResponseItem = Awaited<ReturnType<typeof harness.getAgentResponse>>['items'][number];
    const same: [
      ResponseItem,
    ] extends [
      Item,
    ]
      ? Item extends ResponseItem
        ? true
        : false
      : false = true;
    expect(same).toBe(true);
  });

  it('maps an as-const JSON Schema to its type', () => {
    type Shape = FromJsonSchema<{
      readonly type: 'object';
      readonly properties: {
        readonly done: {
          readonly type: 'number';
        };
        readonly label: {
          readonly type: readonly [
            'string',
            'null',
          ];
        };
        readonly state: {
          readonly enum: readonly [
            'a',
            'b',
          ];
        };
        readonly tags: {
          readonly type: 'array';
          readonly items: {
            readonly type: 'string';
          };
        };
      };
      readonly required: readonly [
        'done',
      ];
    }>;
    const shape: Shape = {
      done: 1,
      label: null,
      state: 'a',
      tags: [
        'x',
      ],
    };
    const minimal: Shape = {
      done: 2,
    };
    // @ts-expect-error: `done` is required.
    const none: Shape = {};
    type Final = CustomItemOf<typeof progress>;
    const final: Final = {
      id: 'i',
      type: 'myapp:progress',
      done: 1,
      of: 1,
    };
    expect([
      shape.done,
      minimal.done,
      final.of,
    ]).toEqual([
      1,
      2,
      1,
    ]);
    expect(frameworkCast<unknown>(none)).toEqual({});
  });
});

//#endregion
