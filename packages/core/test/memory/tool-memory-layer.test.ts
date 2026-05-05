import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createLayerStateStore, initLayers, recallLayers } from '../../src/memory/layer-lifecycle';
import { toolMemoryLayer } from '../../src/memory/layers/tool-memory-layer';
import type { Tool, ToolMemoryDeclaration } from '../../src/types/common';
import { Slot } from '../../src/types/memory';
import { frameworkCast } from '../../src/util/framework-cast';
import { makeCtx, makeItemLog, makeStorage } from '../_helpers';

interface TodoState {
  items: string[];
}

describe('toolMemoryLayer', () => {
  const todoMemory = frameworkCast<ToolMemoryDeclaration>({
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
      memory: todoMemory,
    };
  }

  it('generates one layer per unique memory id', () => {
    const tools = [
      makeTodoTool('write_todos'),
      makeTodoTool('update_todo'),
      makeTodoTool('list_todos'),
    ];
    const layers = toolMemoryLayer(tools);
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
      memory: {
        init: () => ({}),
        recall: () => null,
      },
    };
    const layers = toolMemoryLayer([
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
    const layers = toolMemoryLayer([
      plainTool,
    ]);
    expect(layers).toHaveLength(0);
  });

  it('uses default slot and execution scope', () => {
    const layers = toolMemoryLayer([
      makeTodoTool('t'),
    ]);
    expect(layers[0].slot).toBe(Slot.WORKING_MEMORY + 10);
    expect(layers[0].scope).toBe('execution');
  });

  it('allows custom slot', () => {
    const layers = toolMemoryLayer(
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
    const layers = toolMemoryLayer([
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
    const layers = toolMemoryLayer([
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
