import { describe, expect, it } from 'bun:test';
import type { Tool } from '@noetic-tools/types';
import { z } from 'zod';
import * as context from '../src/index';

describe('@noetic-tools/context public surface', () => {
  it('exports built-in layer factories', () => {
    expect(typeof context.scratchpad).toBe('function');
    expect(typeof context.history).toBe('function');
    expect(typeof context.plan).toBe('function');
    expect(typeof context.toolCalls).toBe('function');
    expect(typeof context.instructions).toBe('function');
    expect(typeof context.temporal).toBe('function');
    expect(typeof context.observations).toBe('function');
    expect(typeof context.filesystem).toBe('function');
    expect(typeof context.taskState).toBe('function');
    expect(typeof context.steering).toBe('function');
  });

  it('exports the layer provides builders', () => {
    expect(typeof context.layerData).toBe('function');
    expect(typeof context.layerFunction).toBe('function');
  });

  it('re-exports the ContextLayer contract (Slot) from @noetic-tools/types', () => {
    expect(context.Slot).toBeDefined();
    expect(context.Slot.WORKING_MEMORY).toBe(100);
  });

  it('exports the budget allocation utilities', () => {
    expect(typeof context.allocateBudgets).toBe('function');
    expect(typeof context.checkBudget).toBe('function');
  });

  it('does not carry the memory-era deprecated aliases', () => {
    const removedNames = [
      'workingMemory',
      'workingMemoryContext',
      'observationalMemory',
      'observationalContext',
      'temporalMemory',
      'temporalContext',
      'planMemory',
      'planContext',
      'toolMemoryLayer',
      'toolContextLayer',
      'buildContextMemory',
      'staticContent',
      'fileReference',
      'historyWindow',
      'durableTaskState',
      'layerFn',
    ];
    const exported = Object.keys(context);
    for (const name of removedNames) {
      expect(exported).not.toContain(name);
    }
  });
});

describe('built-in layer ids and display names', () => {
  it('uses the renamed layer ids', () => {
    expect(context.scratchpad().id).toBe('scratchpad');
    expect(context.history().id).toBe('history');
    expect(context.plan().id).toBe('plan');
    expect(context.taskState().id).toBe('task-state');
    expect(context.temporal().id).toBe('temporal');
    expect(
      context.observations({
        observer: async () => [],
      }).id,
    ).toBe('observations');
    expect(context.filesystem().id).toBe('filesystem');
    expect(
      context.instructions({
        load: async () => 'hello',
      }).id,
    ).toBe('instructions');
  });

  it('uses the renamed display names', () => {
    expect(context.scratchpad().name).toBe('Scratchpad');
    expect(context.history().name).toBe('History');
    expect(context.plan().name).toBe('Plan');
    expect(context.taskState().name).toBe('Task State');
    expect(context.temporal().name).toBe('Temporal');
    expect(
      context.observations({
        observer: async () => [],
      }).name,
    ).toBe('Observations');
    expect(context.filesystem().name).toBe('Filesystem');
  });

  it('instructions honours an explicit id override', () => {
    expect(
      context.instructions({
        id: 'my-instructions',
        load: async () => 'hello',
      }).id,
    ).toBe('my-instructions');
  });

  it('toolCalls keeps per-tool id derivation', () => {
    const makeTool = (name: string, contextId?: string): Tool => ({
      name,
      description: `${name} tool`,
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ok',
      context: {
        id: contextId,
        init: () => ({}),
        recall: () => null,
      },
    });
    const layers = context.toolCalls([
      makeTool('todo'),
      makeTool('notes', 'shared-notes'),
    ]);
    expect(layers.map((l) => l.id).sort()).toEqual(
      [
        'shared-notes',
        'todo',
      ].sort(),
    );
  });
});
