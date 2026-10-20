import { describe, expect, it } from 'bun:test';
import {
  createLayerStateStore,
  initLayers,
  recallLayers,
  Slot,
  toolCalls,
} from '@noetic-tools/context';
import type { Tool, ToolContextDeclaration } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { makeCtx, makeItemLog, makeStorage } from '../_helpers';

interface TodoState {
  items: string[];
}

describe('toolCalls', () => {
  const todoMemory = frameworkCast<ToolContextDeclaration>({
    id: 'todos',
    init: () => ({
      items: [],
    }),
    recall: (state: TodoState) => {
      if (state.items.length === 0) {
        return null;
      }
      return `<todos>\n${state.items.join('\n')}\n</todos>`;
    },
  });

  function makeTodoTool(name: string): Tool {
    return {
      name,
      description: `${name} tool`,
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ok',
      context: todoMemory,
    };
  }

  it('generates one layer per unique memory id', () => {
    const tools = [
      makeTodoTool('write_todos'),
      makeTodoTool('update_todo'),
      makeTodoTool('list_todos'),
    ];
    const layers = toolCalls(tools);
    expect(layers).toHaveLength(1);
    expect(layers[0].id).toBe('todos');
  });

  it('defaults id to tool.name when memory.id is omitted', () => {
    const toolWithoutId: Tool = {
      name: 'my_tool',
      description: 'A tool',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ok',
      context: {
        init: () => ({}),
        recall: () => null,
      },
    };
    const layers = toolCalls([
      toolWithoutId,
    ]);
    expect(layers).toHaveLength(1);
    expect(layers[0].id).toBe('my_tool');
  });

  it('skips tools without memory declarations', () => {
    const plainTool: Tool = {
      name: 'plain',
      description: 'No memory',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ok',
    };
    const layers = toolCalls([
      plainTool,
    ]);
    expect(layers).toHaveLength(0);
  });

  it('uses default slot and execution scope', () => {
    const layers = toolCalls([
      makeTodoTool('t'),
    ]);
    expect(layers[0].slot).toBe(Slot.WORKING_MEMORY + 10);
    expect(layers[0].scope).toBe('execution');
  });

  it('allows custom slot', () => {
    const layers = toolCalls(
      [
        makeTodoTool('t'),
      ],
      {
        slot: 500,
      },
    );
    expect(layers[0].slot).toBe(500);
  });

  it('init and recall lifecycle work end-to-end', async () => {
    const layers = toolCalls([
      makeTodoTool('t'),
    ]);
    const store = createLayerStateStore();
    const ctx = makeCtx({
      executionId: 'exec-tool-mem',
    });

    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });

    const state = store.get<{
      items: string[];
    }>(ctx.executionId, 'todos');
    expect(state).toEqual({
      items: [],
    });

    // Recall with empty state returns null (no items)
    const results = await recallLayers({
      layers,
      query: 'q',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          'todos',
          1e3,
        ],
      ]),
      store,
    });
    expect(results).toHaveLength(0);
  });

  it('recall returns string when state has data', async () => {
    const layers = toolCalls([
      makeTodoTool('t'),
    ]);
    const store = createLayerStateStore();
    const ctx = makeCtx({
      executionId: 'exec-tool-mem-2',
    });

    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });

    // Simulate tool writing state
    store.set(ctx.executionId, 'todos', {
      items: [
        'Buy milk',
      ],
    });

    const results = await recallLayers({
      layers,
      query: 'q',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          'todos',
          1e3,
        ],
      ]),
      store,
    });
    expect(results).toHaveLength(1);
    expect(results[0].items[0].type).toBe('message');
  });
});
