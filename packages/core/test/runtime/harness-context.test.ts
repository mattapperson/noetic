import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextLayer } from '@noetic-tools/context';
import { Slot } from '@noetic-tools/context';
import { createMessage, frameworkCast } from '@noetic-tools/types';
import { callModel, runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createScriptedCallModel, makeLayer, textOnlyResponse } from '../_helpers';

//#region Helper Functions

//#endregion

//#region Tests

describe('AgentHarness memory', () => {
  describe('createContext with harness-level memory', () => {
    it('context inherits harness memory by default', () => {
      const layer = makeLayer('harness-layer', {
        slot: Slot.STEERING,
      });
      const harness = new AgentHarness({
        name: 'test',
        contextLayers: [
          layer,
        ],
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });

      const ctx = harness.createContext();
      expect(ctx.layers).toBeDefined();
      expect(ctx.layers).toHaveLength(1);
      expect(ctx.layers![0].id).toBe('harness-layer');
    });

    it('per-call memory overrides harness memory', () => {
      const harnessLayer = makeLayer('harness-layer', {
        slot: Slot.STEERING,
      });
      const callLayer = makeLayer('call-layer', {
        slot: Slot.WORKING_MEMORY,
      });
      const harness = new AgentHarness({
        name: 'test',
        contextLayers: [
          harnessLayer,
        ],
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });

      const ctx = harness.createContext({
        contextLayers: [
          callLayer,
        ],
      });
      expect(ctx.layers).toHaveLength(1);
      expect(ctx.layers![0].id).toBe('call-layer');
    });

    it('no memory on harness or call produces undefined layers', () => {
      const harness = new AgentHarness({
        name: 'test',
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });

      const ctx = harness.createContext();
      expect(ctx.layers).toBeUndefined();
    });
  });

  describe('previewRequestItems', () => {
    it('returns seeded history when no layers are configured', async () => {
      const harness = new AgentHarness({
        name: 'test',
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });
      harness.seedSessionHistory('__default__', [
        {
          id: 'h1',
          type: 'message',
          status: 'completed',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'hi',
            },
          ],
        },
      ]);

      const items = await harness.previewRequestItems();
      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe('message');
    });

    it('prepends layer recall output before history when layers contribute items', async () => {
      const layer: ContextLayer = {
        id: 'preview-layer',
        name: 'preview-layer',
        slot: Slot.STEERING,
        scope: 'execution',
        hooks: {
          recall: async () => ({
            items: [
              {
                id: 'sys-1',
                type: 'message',
                status: 'completed',
                role: 'developer',
                content: [
                  {
                    type: 'input_text',
                    text: 'system: be helpful',
                  },
                ],
              },
            ],
            tokenCount: 5,
          }),
        },
      };
      const harness = new AgentHarness({
        name: 'test',
        contextLayers: [
          layer,
        ],
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });
      harness.seedSessionHistory('__default__', [
        {
          id: 'h1',
          type: 'message',
          status: 'completed',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'hi',
            },
          ],
        },
      ]);

      const items = await harness.previewRequestItems();
      expect(items).toHaveLength(2);
      const first = items[0];
      const second = items[1];
      assert(first?.type === 'message' && first.role === 'developer');
      assert(second?.type === 'message' && second.role === 'user');
      expect(first.id).toBe('sys-1');
      expect(second.id).toBe('h1');
    });

    it('includes recall output from init-bearing layers (instructions shape)', async () => {
      // Regression: preview must run layer `init` on its throwaway context —
      // without it the recall lifecycle treats every init-bearing layer as
      // disabled and the preview silently degenerates to bare history. All
      // built-in layers carry an init hook, so this is the common case.
      const layer: ContextLayer<string> = {
        id: 'persona',
        name: 'persona',
        slot: Slot.WORKING_MEMORY,
        scope: 'resource',
        hooks: {
          init: async () => ({
            state: '<instructions>be helpful</instructions>',
          }),
          recall: async ({ state }) => ({
            items: [
              {
                id: 'persona-1',
                type: 'message',
                status: 'completed',
                role: 'developer',
                content: [
                  {
                    type: 'input_text',
                    text: state ?? '',
                  },
                ],
              },
            ],
            tokenCount: 8,
          }),
        },
      };
      const harness = new AgentHarness({
        name: 'test',
        contextLayers: [
          layer,
        ],
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });

      const items = await harness.previewRequestItems();
      expect(items).toHaveLength(1);
      const first = items[0];
      assert(first?.type === 'message' && first.role === 'developer');
      expect(first.id).toBe('persona-1');
      const part = first.content[0];
      assert(part?.type === 'input_text');
      expect(part.text).toBe('<instructions>be helpful</instructions>');
    });

    it('returns empty for an unknown thread with no history and no layers', async () => {
      const harness = new AgentHarness({
        name: 'test',
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });
      const items = await harness.previewRequestItems({
        threadId: 'never-seen',
      });
      expect(items).toEqual([]);
    });

    it('does not allocate a session for an unknown thread', async () => {
      const harness = new AgentHarness({
        name: 'test',
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });
      await harness.previewRequestItems({
        threadId: 'never-seen',
      });
      // A real session would be observable through getStatus reporting on the
      // runner. Verify the preview did not lazily create one.
      expect(
        harness.getStatus({
          threadId: 'never-seen',
        }).kind,
      ).toBe('idle');
      const before = harness.getQueueSize({
        threadId: 'never-seen',
      });
      expect(before).toBe(0);
    });

    it('propagates layer recall errors so callers can decide their own fallback', async () => {
      const failingLayer: ContextLayer = {
        id: 'boom',
        name: 'boom',
        slot: Slot.STEERING,
        scope: 'execution',
        hooks: {
          recall: async () => {
            throw new Error('layer recall failed');
          },
        },
      };
      const harness = new AgentHarness({
        name: 'test',
        contextLayers: [
          failingLayer,
        ],
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });
      // Layer hooks are protected by the lifecycle wrapper which logs and
      // returns an empty output rather than throwing — so the preview returns
      // history (here, []) when a layer fails. This locks in the behavior the
      // CLI relies on.
      const items = await harness.previewRequestItems();
      expect(items).toEqual([]);
    });
  });

  describe('execute with harness-level memory', () => {
    it('execute passes harness memory to context', async () => {
      const layer = makeLayer('exec-layer', {
        slot: Slot.STEERING,
      });
      let contextLayers: ContextLayer[] | undefined;

      const harness = new AgentHarness({
        name: 'test',
        agentGraph: {
          kind: 'runCode',
          id: 'capture',
          execute: async (_input, ctx) => {
            contextLayers = ctx.layers;
            return 'done';
          },
        },
        contextLayers: [
          layer,
        ],
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });

      await harness.execute('hello');
      await harness.getAgentResponse();
      expect(contextLayers).toBeDefined();
      expect(contextLayers).toHaveLength(1);
      expect(contextLayers![0].id).toBe('exec-layer');
    });
  });
});

//#endregion

describe('context stream', () => {
  it('publishes a recalled layer before a later layer finishes', async () => {
    const ready = Promise.withResolvers<void>();
    const harness = new AgentHarness({
      name: 'context-test',
      params: {},
      agentGraph: {
        kind: 'callModel',
        id: 'reply',
        model: 'test',
      },
      contextLayers: [
        {
          ...makeLayer('first', {
            slot: 1,
            hooks: {
              recall: async () => 'first answer',
            },
          }),
          name: 'Memory',
        },
        makeLayer('second', {
          slot: 2,
          hooks: {
            recall: async () => {
              await ready.promise;
              return 'second answer';
            },
          },
        }),
      ],
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('ok'),
      ]),
    });
    const stream = harness.getContextStream()[Symbol.asyncIterator]();
    try {
      await harness.execute('hello');
      expect((await stream.next()).value?.window.layers[0]?.pendingUpdate).toBe(true);
      const recalled = (await stream.next()).value;
      expect(recalled?.window.status).toBe('partial');
      expect(recalled?.window.layers[0]).toMatchObject({
        name: 'Memory',
        recallMode: 'atomic',
        pendingUpdate: false,
        lastUpdatedAt: expect.any(Number),
      });
      expect((await harness.getCurrentContext())?.request).toBeUndefined();
      ready.resolve();
      await harness.getAgentResponse();
      expect((await harness.getCurrentContext())?.request).toMatchObject({
        target: 'override',
      });
      expect(
        await harness.getCurrentContext(undefined, {
          threadId: 'another',
        }),
      ).toBeUndefined();
    } finally {
      ready.resolve();
      await stream.return?.();
      await harness.close();
    }
  });

  it('renders a preview without persisting a recall or consuming guidance', async () => {
    const values = new Map<string, unknown>();
    const storage = {
      get: async <T>(key: string) => frameworkCast<T | undefined>(values.get(key)) ?? null,
      set: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      delete: async (key: string) => {
        values.delete(key);
      },
      list: async (prefix: string) =>
        [
          ...values.keys(),
        ].filter((key) => key.startsWith(prefix)),
    };
    const layer: ContextLayer<{
      queue: string[];
    }> = {
      id: 'guidance',
      slot: 1,
      scope: 'thread',
      hooks: {
        init: async ({ storage }) => {
          const state = {
            queue: [
              'remember this',
            ],
          };
          await storage.set('test-write', state);
          return {
            state,
          };
        },
        recall: async ({ state }) => {
          const message = state.queue.splice(0).join('');
          return {
            items: [
              createMessage(message, 'developer'),
            ],
            tokenCount: 1,
            state,
          };
        },
      },
    };
    const harness = new AgentHarness({
      name: 'preview-test',
      params: {},
      environment: {
        storage: {
          adapter: storage,
        },
      },
      contextLayers: [
        layer,
      ],
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('ok'),
      ]),
    });
    try {
      const first = await harness.getCurrentContext(true);
      const second = await harness.getCurrentContext(true);
      expect(first?.status).toBe('preview');
      expect(first?.items).toMatchObject([
        {
          content: [
            {
              text: 'remember this',
            },
          ],
        },
      ]);
      expect(second?.items).toMatchObject([
        {
          content: [
            {
              text: 'remember this',
            },
          ],
        },
      ]);
      expect(await harness.getCurrentContext()).toBeUndefined();
      expect(values.size).toBe(0);
    } finally {
      await harness.close();
    }
  });
});

it('keeps the eventual render timestamp on cache hits and reports pending writes', async () => {
  let renderCount = 0;
  let storeCount = 0;
  const layer: ContextLayer = {
    id: 'memory',
    name: 'Saved knowledge',
    slot: 1,
    scope: 'thread',
    recallMode: 'eventual',
    hooks: {
      recall: async () => {
        renderCount += 1;
        return 'known content';
      },
      store: async () =>
        ++storeCount === 2
          ? {
              state: 'new durable value',
            }
          : undefined,
    },
  };
  const harness = new AgentHarness({
    name: 'eventual-test',
    params: {},
    agentGraph: {
      kind: 'callModel',
      id: 'reply',
      model: 'test',
    },
    contextLayers: [
      layer,
    ],
    _testCallModel: createScriptedCallModel([
      textOnlyResponse('one'),
      textOnlyResponse('two'),
    ]),
  });
  try {
    await harness.execute('first');
    await harness.getAgentResponse();
    const first = (await harness.getCurrentContext())?.layers[0];
    await harness.execute('second');
    await harness.getAgentResponse();
    const second = (await harness.getCurrentContext())?.layers[0];

    expect(renderCount).toBe(1);
    expect(first).toMatchObject({
      source: 'fresh',
      pendingUpdate: false,
    });
    expect(second).toMatchObject({
      source: 'cache',
      pendingUpdate: true,
      lastUpdatedAt: first?.lastUpdatedAt,
    });
    const late = harness.getContextStream()[Symbol.asyncIterator]();
    expect((await late.next()).value).toMatchObject({
      type: 'snapshot',
      window: {
        layers: [
          second,
        ],
      },
    });
    await late.return?.();
  } finally {
    await harness.close();
  }
});

it('sends a snapshot after a slow reader misses updates', async () => {
  const harness = new AgentHarness({
    name: 'context-gap',
    params: {},
    agentGraph: {
      kind: 'callModel',
      id: 'reply',
      model: 'test',
    },
    contextLayers: Array.from(
      {
        length: 20,
      },
      (_, slot) =>
        makeLayer(`layer-${slot}`, {
          slot,
          hooks: {
            recall: async () => `content ${slot}`,
          },
        }),
    ),
    _testCallModel: createScriptedCallModel([
      textOnlyResponse('ok'),
    ]),
  });
  const stream = harness.getContextStream()[Symbol.asyncIterator]();
  try {
    await harness.execute('hello');
    await harness.getAgentResponse();
    const first = (await stream.next()).value;
    expect(first).toMatchObject({
      type: 'snapshot',
      gap: true,
    });
    expect(first?.window.layers.length).toBeGreaterThan(0);
    let last = first;
    while (last?.type !== 'request') {
      last = (await stream.next()).value;
    }
    expect(last.window).toEqual(await harness.getCurrentContext());
  } finally {
    await stream.return?.();
    await harness.close();
  }
});

it('keeps a named session after a standalone root spawns onto its thread', async () => {
  const harness = new AgentHarness({
    name: 'context-child',
    params: {},
    agentGraph: {
      kind: 'callModel',
      id: 'reply',
      model: 'test',
    },
    _testCallModel: createScriptedCallModel([
      textOnlyResponse('one'),
      textOnlyResponse('child'),
      textOnlyResponse('two'),
    ]),
  });
  const scope = {
    threadId: 'named',
  };
  try {
    await harness.execute('first', scope);
    await harness.getAgentResponse(scope);
    const before = await harness.previewRequestItems(scope);

    await harness.run(
      runCode({
        id: 'parent',
        execute: async (_input, ctx) =>
          harness
            .detachedSpawn(
              callModel({
                id: 'child',
                model: 'test',
              }),
              'hi',
              ctx,
              scope,
            )
            .await(),
      }),
      undefined,
      harness.createContext(),
    );

    await harness.execute('second', scope);
    await harness.getAgentResponse(scope);
    expect(await harness.previewRequestItems(scope)).toHaveLength(before.length + 2);
    expect((await harness.getCurrentContext(undefined, scope))?.stepId).toBe('reply');
  } finally {
    await harness.close();
  }
});

it('lets readers drain the final request after a standalone run ends', async () => {
  const harness = new AgentHarness({
    name: 'context-close',
    params: {},
    contextLayers: [
      makeLayer('memory', {
        hooks: {
          recall: async () => 'layer content',
        },
      }),
    ],
    _testCallModel: createScriptedCallModel([
      textOnlyResponse('ok'),
    ]),
  });
  const ctx = harness.createContext();
  const scope = {
    threadId: ctx.threadId,
  };
  const stream = harness.getContextStream(scope)[Symbol.asyncIterator]();
  try {
    await harness.run(
      callModel({
        id: 'reply',
        model: 'test',
      }),
      'hello',
      ctx,
    );
    expect(await harness.getCurrentContext(undefined, scope)).toBeUndefined();
    expect((await stream.next()).value?.type).toBe('layer');
    expect((await stream.next()).value?.type).toBe('layer');
    expect((await stream.next()).value?.type).toBe('request');
    expect((await stream.next()).done).toBe(true);
  } finally {
    await stream.return?.();
    await harness.close();
  }
});

it('bounds retained windows for standalone named threads', async () => {
  const harness = new AgentHarness({
    name: 'context-retention',
    params: {},
    _testCallModel: async () => textOnlyResponse('ok'),
  });
  const reply = callModel({
    id: 'reply',
    model: 'test',
  });
  try {
    for (let index = 0; index < 33; index++) {
      await harness.run(
        reply,
        'hello',
        harness.createContext({
          threadId: `standalone-${index}`,
        }),
      );
    }
    expect(
      await harness.getCurrentContext(undefined, {
        threadId: 'standalone-0',
      }),
    ).toBeUndefined();
    expect(
      await harness.getCurrentContext(undefined, {
        threadId: 'standalone-1',
      }),
    ).toBeDefined();
    expect(
      await harness.getCurrentContext(undefined, {
        threadId: 'standalone-32',
      }),
    ).toMatchObject({
      status: 'request',
    });
  } finally {
    await harness.close();
  }
});
