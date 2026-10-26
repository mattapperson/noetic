// `emitItems`: any step (JSON node or programmatic) adds items to the conversation
// the moment it finishes, so a workflow emits before its last step — on every loop
// iteration, before the loop's exit test stops it.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type {
  DecideResponse,
  Item,
  Step,
  StreamEvent,
  StreamingItem,
  WorkflowDocument,
} from '@noetic-tools/types';
import { frameworkCast, isAssistantMessage, isNoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import { parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import { loop } from '../../src/builders/loop-builder';
import { runCode } from '../../src/builders/step-builders';
import { workflow } from '../../src/builders/workflow-step';
import { AgentHarness } from '../../src/harness/agent-harness';
import { execute } from '../../src/interpreter/execute';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { WorkflowNode } from '../../src/schemas/workflow';
import { WorkflowNodeSchema } from '../../src/schemas/workflow';
import { until } from '../../src/until/predicates';
import { makeMockContext, makeTestTool } from '../_helpers';

//#region Helpers

/** Counts `n` down to 0, emitting the state after every iteration. */
const COUNTDOWN: WorkflowNode = {
  kind: 'loop',
  id: 'countdown',
  maxIterations: 'infinity',
  body: {
    kind: 'compute',
    id: 'tick',
    expr: "{ 'n': n - 1 }",
    emitItems: true,
  },
  until: {
    kind: 'expr',
    expr: 'n = 0',
  },
};

function emitted(items: ReadonlyArray<Item>): string[] {
  return items.filter(isAssistantMessage).flatMap((item) =>
    item.content.flatMap((part) =>
      part.type === 'output_text'
        ? [
            part.text,
          ]
        : [],
    ),
  );
}

async function runJson(
  root: WorkflowNode,
  input: string,
  customItems?: WorkflowDocument['customItems'],
) {
  const harness = new AgentHarness({
    name: 'json-emit',
    params: {},
    _testDecide: async (): Promise<DecideResponse> => ({
      answers: {
        stop: {
          type: 'boolean',
          value: true,
          probability: 0.9,
        },
      },
      source: 'native',
      modelId: 'typesafe/jev-1.14',
      usage: {
        inputTokens: 1,
        outputTokens: 0,
      },
    }),
  });
  const ctx = harness.createContext();
  const output = await parseAndRunWorkflow({
    json: {
      version: 1,
      customItems,
      root,
    },
    harness,
    ctx,
    tools: [],
    input,
  });
  return {
    output,
    items: ctx.itemLog.items,
    emitted: emitted(ctx.itemLog.items),
  };
}

/** A custom item type, prefixed per the OpenResponses `prefix:name` convention. */
const ProgressItemSchema = z.object({
  type: z.literal('myapp:progress'),
  id: z.string().optional(),
  done: z.number(),
});

const PROGRESS_SCHEMAS = {
  schemas: {
    items: [
      ProgressItemSchema,
    ],
  },
};

function progress(items: ReadonlyArray<Item>): unknown[] {
  return items.filter((item) => item.type === 'myapp:progress');
}

/** Captures framework events where a session would stream them. */
function captureEvents(ctx: unknown): StreamEvent[] {
  const events: StreamEvent[] = [];
  frameworkCast<{
    _broadcaster: unknown;
  }>(ctx)._broadcaster = {
    emit: (event: StreamEvent) => events.push(event),
  };
  return events;
}

function streamedText(events: StreamEvent[]): string[] {
  return emitted(
    events.flatMap((event) =>
      event.type.endsWith(':item_appended')
        ? [
            frameworkCast<Item>(event.data.item),
          ]
        : [],
    ),
  );
}

function durableHarness(
  storage: ReturnType<typeof createInMemoryStorage>,
  emitItemsOnReplay?: boolean,
) {
  return new AgentHarness({
    name: 'emit-resume',
    params: {},
    emitItemsOnReplay,
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

async function expectConfigError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected ${code}`);
  } catch (e) {
    assert(isNoeticConfigError(e));
    expect(e.code).toBe(code);
  }
}

//#endregion

//#region Tests

/** A JSON-declared custom item: progress with a count event and a done/of final. */
const PROGRESS_JSON = {
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
} satisfies WorkflowDocument['customItems'];

describe('emitItems in the workflow schema', () => {
  it('accepts a boolean or the hook form on any node', () => {
    for (const emitItems of [
      true,
      false,
      {
        onDone: "'n is ' & n",
      },
      {},
      {
        item: 'progress',
      },
      {
        item: 'progress',
        onStart: "{ 'done': 0 }",
        onDone: "{ 'done': n, 'of': n }",
      },
    ]) {
      expect(
        WorkflowNodeSchema.safeParse({
          kind: 'compute',
          id: 'c',
          expr: 'n',
          emitItems,
        }).success,
      ).toBe(true);
    }
  });

  it('rejects any other shape, and onStart without an item', () => {
    for (const emitItems of [
      'yes',
      {
        onDone: 5,
      },
      {
        onStart: 'n',
      },
      {
        expr: 'n',
      },
      {
        replay: true,
      },
    ]) {
      expect(
        WorkflowNodeSchema.safeParse({
          kind: 'compute',
          id: 'c',
          expr: 'n',
          emitItems,
        }).success,
      ).toBe(false);
    }
  });

  it('accepts customItems at the root and on a node, and rejects a type without a prefix', () => {
    const node = {
      kind: 'compute',
      id: 'c',
      expr: 'n',
      customItems: PROGRESS_JSON,
    };
    expect(WorkflowNodeSchema.safeParse(node).success).toBe(true);
    expect(
      WorkflowNodeSchema.safeParse({
        ...node,
        customItems: {
          bad: {
            ...PROGRESS_JSON.progress,
            type: 'progress',
          },
        },
      }).success,
    ).toBe(false);
  });

  it('fails validation when an emitItems expression does not parse', async () => {
    await expectConfigError(
      runJson(
        {
          kind: 'compute',
          id: 'c',
          expr: 'n',
          emitItems: {
            onDone: "'unclosed",
          },
        },
        '{"n":1}',
      ),
      'WORKFLOW_VALIDATION_FAILED',
    );
  });
});

describe('emitItems in JSON workflows', () => {
  it('a step inside a loop emits its output on every iteration', async () => {
    const { output, emitted: messages } = await runJson(COUNTDOWN, '{"n":3}');
    expect(output).toBe('{"n":0}');
    expect(messages).toEqual([
      '{"n":2}',
      '{"n":1}',
      '{"n":0}',
    ]);
  });

  it('a node without emitItems adds nothing to the log', async () => {
    const { emitted: messages } = await runJson(
      {
        kind: 'compute',
        id: 'quiet',
        expr: 'n + 1',
      },
      '{"n":1}',
    );
    expect(messages).toEqual([]);
  });

  it('emitItems false is the same as none', async () => {
    const { emitted: messages } = await runJson(
      {
        kind: 'compute',
        id: 'quiet',
        expr: 'n + 1',
        emitItems: false,
      },
      '{"n":1}',
    );
    expect(messages).toEqual([]);
  });

  it('onDone without an item emits text, and nothing when it gives no value', async () => {
    const { emitted: messages } = await runJson(
      {
        ...COUNTDOWN,
        body: {
          kind: 'compute',
          id: 'tick',
          expr: "{ 'n': n - 1 }",
          emitItems: {
            onDone: "n % 2 = 0 ? 'even: ' & $string(n)",
          },
        },
      },
      '{"n":5}',
    );
    expect(messages).toEqual([
      'even: 4',
      'even: 2',
      'even: 0',
    ]);
  });

  it('onDone without an item writes a structured value as JSON', async () => {
    const { emitted: messages } = await runJson(
      {
        kind: 'compute',
        id: 'c',
        expr: "{ 'n': n }",
        emitItems: {
          onDone: "{ 'left': n }",
        },
      },
      '{"n":2}',
    );
    expect(messages).toEqual([
      '{"left":2}',
    ]);
  });

  it('fails with EXPRESSION_FAILED when an emitItems expression gives a function', async () => {
    await expectConfigError(
      runJson(
        {
          kind: 'compute',
          id: 'c',
          expr: 'n',
          emitItems: {
            onDone: '$uppercase',
          },
        },
        '{"n":1}',
      ),
      'EXPRESSION_FAILED',
    );
  });

  it('a decide node used as the loop exit emits its answers before the loop stops', async () => {
    const { emitted: messages } = await runJson(
      {
        kind: 'loop',
        id: 'once',
        body: {
          kind: 'compute',
          id: 'work',
          expr: "{ 'n': n + 1 }",
        },
        until: {
          kind: 'decide',
          id: 'done',
          model: 'typesafe/jev-1.14',
          questions: {
            stop: {
              type: 'boolean',
              instructions: 'Done?',
            },
          },
          emitItems: {
            onDone: "stop.value ? 'finished' : 'again'",
          },
        },
      },
      '{"n":0}',
    );
    expect(messages).toEqual([
      'finished',
    ]);
  });

  it('a container node emits its own output once it finishes', async () => {
    const { emitted: messages } = await runJson(
      {
        kind: 'sequence',
        id: 'pipe',
        emitItems: true,
        steps: [
          {
            kind: 'compute',
            id: 'a',
            expr: "{ 'n': n * 2 }",
            emitItems: true,
          },
          {
            kind: 'compute',
            id: 'b',
            expr: "{ 'n': n + 1 }",
          },
        ],
      },
      '{"n":3}',
    );
    expect(messages).toEqual([
      '{"n":6}',
      '{"n":7}',
    ]);
  });
});

describe('emitted items stream before the workflow ends', () => {
  it('getItemStream yields each emitted message while later steps still run', async () => {
    const collected: StreamingItem[] = [];
    let release: () => void = () => {};
    const sawAll = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The workflow's last step blocks until the stream has carried every loop
    // message, so this only finishes if they streamed mid-run.
    const gate = makeTestTool({
      name: 'gate',
      execute: async () => {
        await sawAll;
        return {
          result: 'done',
        };
      },
    });
    const document: WorkflowDocument = {
      version: 1,
      root: {
        kind: 'sequence',
        id: 'main',
        steps: [
          {
            kind: 'compute',
            id: 'seed',
            expr: "{ 'n': 3 }",
          },
          COUNTDOWN,
          {
            kind: 'invokeTool',
            id: 'finish',
            toolName: 'gate',
            args: {
              query: 'x',
            },
          },
        ],
      },
    };
    const harness = new AgentHarness({
      name: 'json-emit-stream',
      params: {},
      agentGraph: workflow({
        id: 'flow',
        document,
        tools: [
          gate,
        ],
      }),
    });
    async function pump(): Promise<void> {
      for await (const item of harness.getItemStream()) {
        collected.push(item);
        if (emitted(collected).length === 3) {
          release();
        }
      }
    }
    void pump();

    await harness.execute('go');
    const response = await harness.getAgentResponse();

    expect(emitted(collected)).toEqual([
      '{"n":2}',
      '{"n":1}',
      '{"n":0}',
    ]);
    expect(emitted(response.items)).toEqual([
      '{"n":2}',
      '{"n":1}',
      '{"n":0}',
    ]);
    expect(response.text).toBe('{"result":"done"}');
  });
});

describe('emitItems on programmatic steps', () => {
  it('an emitItems function picks the text; undefined or empty emits nothing', async () => {
    const step: Step<ContextData, number, number> = runCode<ContextData, number, number>({
      id: 'double',
      execute: async (n) => n * 2,
      emitItems: (n) => (n > 2 ? `got ${n}` : n === 2 ? '' : undefined),
    });
    const ctx = makeMockContext();
    for (const n of [
      0,
      1,
      2,
    ]) {
      await execute(step, n, ctx);
    }
    expect(emitted(ctx.itemLog.items)).toEqual([
      'got 4',
    ]);
  });

  it('emitItems true writes non-string output as JSON', async () => {
    const step = runCode<ContextData, string, unknown>({
      id: 'obj',
      execute: async () => ({
        ok: true,
      }),
      emitItems: true,
    });
    const ctx = makeMockContext();
    await execute(frameworkCast<Step>(step), '', ctx);
    expect(emitted(ctx.itemLog.items)).toEqual([
      '{"ok":true}',
    ]);
  });

  it('an emitItems function can give items, including custom ones', async () => {
    const harness = new AgentHarness({
      name: 'emit-items',
      params: {},
      itemSchemas: PROGRESS_SCHEMAS,
    });
    const step = runCode<ContextData, number, number>({
      id: 'count',
      execute: async (n) => n + 1,
      emitItems: (n) => [
        {
          type: 'myapp:progress',
          done: n,
        },
        {
          id: `note-${n}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: `at ${n}`,
              annotations: [],
            },
          ],
        },
      ],
    });
    const ctx = harness.createContext();
    await harness.run(step, 1, ctx);
    expect(progress(ctx.itemLog.items)).toEqual([
      {
        type: 'myapp:progress',
        done: 2,
      },
    ]);
    expect(emitted(ctx.itemLog.items)).toEqual([
      'at 2',
    ]);
  });

  function emitter(runs: { count: number }) {
    return runCode<ContextData, string, string>({
      id: 'emit',
      execute: async (_input, ctx) => {
        runs.count++;
        // Appended outside emitItems: replay puts it back, but never streams it.
        ctx.itemLog.append(
          frameworkCast<Item>({
            type: 'myapp:progress',
            done: 0,
          }),
        );
        return 'hello';
      },
      emitItems: true,
    });
  }

  async function crashAndResume(emitItemsOnReplay: boolean | undefined) {
    const storage = createInMemoryStorage();
    const runs = {
      count: 0,
    };
    const crashing = runCode<ContextData, string, string>({
      id: 'crash',
      execute: async () => {
        throw new Error('host died');
      },
    });
    const flow = (last: Step<ContextData, string, string>) =>
      loop<ContextData, string, string>({
        id: 'flow',
        steps: [
          emitter(runs),
          last,
        ],
        until: until.maxSteps(1),
      });
    const harness = new AgentHarness({
      name: 'emit-resume',
      params: {},
      itemSchemas: PROGRESS_SCHEMAS,
      environment: {
        storage: {
          adapter: storage,
          checkpointStore: createCheckpointStore({
            storage,
          }),
        },
      },
    });
    const ctx = harness.createContext();
    await expect(harness.run(flow(crashing), 'go', ctx)).rejects.toThrow('host died');

    const resumedHarness = new AgentHarness({
      name: 'emit-resume',
      params: {},
      itemSchemas: PROGRESS_SCHEMAS,
      emitItemsOnReplay,
      environment: {
        storage: {
          adapter: storage,
          checkpointStore: createCheckpointStore({
            storage,
          }),
        },
      },
    });
    const resumed = await resumedHarness.restore(ctx.id);
    assert(resumed);
    const events = captureEvents(resumed);
    const finish = runCode<ContextData, string, string>({
      id: 'crash',
      execute: async (input) => input,
    });
    expect(await resumedHarness.run(flow(finish), 'go', resumed)).toBe('hello');
    return {
      runs: runs.count,
      log: resumed.itemLog.items,
      streamed: streamedText(events),
      streamedProgress: progress(
        events.flatMap((event) =>
          event.type.endsWith(':item_appended')
            ? [
                frameworkCast<Item>(event.data.item),
              ]
            : [],
        ),
      ),
    };
  }

  it('a replayed step rebuilds the log quietly by default', async () => {
    const { runs, log, streamed } = await crashAndResume(undefined);
    expect(runs).toBe(1);
    expect(emitted(log)).toEqual([
      'hello',
    ]);
    expect(progress(log)).toHaveLength(1);
    expect(streamed).toEqual([]);
  });

  it('emitItemsOnReplay streams the emitted items again, once, and nothing else', async () => {
    const { runs, log, streamed, streamedProgress } = await crashAndResume(true);
    expect(runs).toBe(1);
    expect(streamed).toEqual([
      'hello',
    ]);
    expect(streamedProgress).toEqual([]);
    expect(emitted(log)).toEqual([
      'hello',
    ]);
    expect(progress(log)).toHaveLength(1);
  });

  it('emitItemsOnReplay re-streams on a same-context retry of a failed run', async () => {
    const storage = createInMemoryStorage();
    let crash = true;
    let runs = 0;
    const flow = loop<ContextData, string, string>({
      id: 'flow',
      steps: [
        runCode<ContextData, string, string>({
          id: 'emit',
          execute: async () => {
            runs++;
            return 'hello';
          },
          emitItems: true,
        }),
        runCode<ContextData, string, string>({
          id: 'gate',
          execute: async (input) => {
            if (crash) {
              throw new Error('host died');
            }
            return input;
          },
        }),
      ],
      until: until.maxSteps(1),
    });
    const harness = durableHarness(storage, true);
    const ctx = harness.createContext();
    const events = captureEvents(ctx);
    await expect(harness.run(flow, 'go', ctx)).rejects.toThrow('host died');

    crash = false;
    events.length = 0;
    expect(await harness.run(flow, 'go', ctx)).toBe('hello');
    expect(runs).toBe(1);
    expect(streamedText(events)).toEqual([
      'hello',
    ]);
    expect(emitted(ctx.itemLog.items)).toEqual([
      'hello',
    ]);
  });

  it('emitItemsOnReplay re-streams what a finished loop emitted when a crashed run resumes', async () => {
    const storage = createInMemoryStorage();
    let crash = true;
    const gate = makeTestTool({
      name: 'gate',
      execute: async () => {
        if (crash) {
          throw new Error('host died');
        }
        return {
          result: 'done',
        };
      },
    });
    const document: WorkflowDocument = {
      version: 1,
      root: {
        kind: 'sequence',
        id: 'main',
        steps: [
          COUNTDOWN,
          {
            kind: 'invokeTool',
            id: 'finish',
            toolName: 'gate',
            args: {
              query: 'x',
            },
          },
        ],
      },
    };
    const flow = () =>
      workflow({
        id: 'flow',
        document,
        tools: [
          gate,
        ],
      });
    const harness = durableHarness(storage);
    const ctx = harness.createContext();
    await expect(harness.run(flow(), '{"n":2}', ctx)).rejects.toThrow();

    crash = false;
    const resumedHarness = durableHarness(storage, true);
    const resumed = await resumedHarness.restore(ctx.id);
    assert(resumed);
    const events = captureEvents(resumed);
    await resumedHarness.run(flow(), '{"n":2}', resumed);
    expect(streamedText(events)).toEqual([
      '{"n":1}',
      '{"n":0}',
    ]);
    expect(emitted(resumed.itemLog.items)).toEqual([
      '{"n":1}',
      '{"n":0}',
    ]);
  });

  it('a failed step emits nothing', async () => {
    const step = runCode<ContextData, string, string>({
      id: 'boom',
      execute: async () => {
        throw new Error('boom');
      },
      emitItems: true,
    });
    const ctx = makeMockContext();
    await expect(execute(step, '', ctx)).rejects.toThrow();
    expect(emitted(ctx.itemLog.items)).toEqual([]);
  });
});

//#endregion
