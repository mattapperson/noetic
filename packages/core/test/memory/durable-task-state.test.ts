import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { DurableTaskState } from '../../src/memory/layers/durable-task-state';
import { durableTaskState } from '../../src/memory/layers/durable-task-state';
import { makeCtx, makeItemLog, makeScopedStorage as makeStorage } from '../_helpers';

describe('durableTaskState', () => {
  it('has correct id and slot', () => {
    const layer = durableTaskState();
    expect(layer.id).toBe('durable-task-state');
    expect(layer.slot).toBe(110);
    expect(layer.scope).toBe('execution');
  });

  it('init/recall lifecycle', async () => {
    const layer = durableTaskState();
    const result = await layer.hooks.init!({
      storage: makeStorage(),
      scopeKey: 'exec-1',
      ctx: makeCtx(),
    });
    expect(result.state).toEqual({
      checkpoints: [],
      files: [],
      data: {},
    });

    const recalled = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx: makeCtx(),
      state: result.state,
      budget: 500,
    });
    expect(recalled).not.toBeNull();
    assert(typeof recalled !== 'string');
    const msg = recalled!.items[0];
    assert(msg.type === 'message');
    const part = msg.content[0];
    assert(part.type === 'input_text');
    expect(part.text).toContain('<task_state>');
  });

  it('onSpawn always provides child state', async () => {
    const layer = durableTaskState();
    const parentState = {
      checkpoints: [
        {
          timestamp: 1,
          depth: 0,
        },
      ],
      files: [
        'a.ts',
      ],
      data: {
        key: 'val',
      },
    };
    const result = await layer.hooks.onSpawn!({
      parentState,
      childCtx: makeCtx(),
    });
    expect(result).not.toBeNull();
    expect(result!.childState).toEqual(parentState);
    // Should be a clone
    expect(result!.childState).not.toBe(parentState);
  });

  it('store hook accumulates checkpoints', async () => {
    const layer = durableTaskState();
    const state: DurableTaskState = {
      checkpoints: [],
      files: [],
      data: {},
    };
    const result1 = await layer.hooks.store!({
      newItems: [],
      log: makeItemLog(),
      response: {
        items: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      ctx: makeCtx(),
      state,
    });
    assert(result1 !== undefined);
    const result2 = await layer.hooks.store!({
      newItems: [],
      log: makeItemLog(),
      response: {
        items: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      ctx: makeCtx(),
      state: result1.state,
    });
    assert(result2 !== undefined);
    expect(result2.state.checkpoints).toHaveLength(2);
    expect(result2.state.checkpoints[0]).toHaveProperty('timestamp');
    expect(result2.state.checkpoints[0]).toHaveProperty('depth');
  });

  it('onReturn with conflicting keys: child overwrites parent', async () => {
    const layer = durableTaskState();
    const parentState: DurableTaskState = {
      checkpoints: [],
      files: [],
      data: {
        key: 'parent-value',
      },
    };
    const childState: DurableTaskState = {
      checkpoints: [],
      files: [],
      data: {
        key: 'child-value',
      },
    };
    const result = await layer.hooks.onReturn!({
      childState,
      childLog: makeItemLog(),
      parentState,
      result: 'done',
    });
    assert(result !== undefined);
    // { ...parent.data, ...child.data } → child overwrites
    expect(result.parentState.data.key).toBe('child-value');
  });

  it('onReturn merges child artifacts back', async () => {
    const layer = durableTaskState();
    const parentState: DurableTaskState = {
      checkpoints: [
        {
          timestamp: 1,
          depth: 0,
        },
      ],
      files: [
        'a.ts',
      ],
      data: {
        x: 1,
      },
    };
    const childState: DurableTaskState = {
      checkpoints: [
        {
          timestamp: 2,
          depth: 0,
        },
      ],
      files: [
        'b.ts',
      ],
      data: {
        y: 2,
      },
    };
    const result = await layer.hooks.onReturn!({
      childState,
      childLog: makeItemLog(),
      parentState,
      result: 'done',
    });
    assert(result !== undefined);
    expect(result.parentState.checkpoints).toHaveLength(2);
    expect(result.parentState.files).toContain('a.ts');
    expect(result.parentState.files).toContain('b.ts');
    expect(result.parentState.data).toEqual({
      x: 1,
      y: 2,
    });
  });

  it('onComplete returns state with outcome and checkpoint', async () => {
    const layer = durableTaskState();
    const state: DurableTaskState = {
      checkpoints: [],
      files: [],
      data: {},
    };
    const result = await layer.hooks.onComplete!({
      log: makeItemLog(),
      ctx: makeCtx(),
      state,
      outcome: 'success',
    });
    assert(result !== undefined);
    expect(result.state.data.__outcome).toBe('success');
    expect(result.state.checkpoints).toHaveLength(1);
    expect(result.state.checkpoints[0]).toHaveProperty('timestamp');
  });

  it('onComplete returns state with failure outcome', async () => {
    const layer = durableTaskState();
    const state: DurableTaskState = {
      checkpoints: [
        {
          timestamp: 1,
          depth: 0,
        },
      ],
      files: [],
      data: {},
    };
    const result = await layer.hooks.onComplete!({
      log: makeItemLog(),
      ctx: makeCtx(),
      state,
      outcome: 'failure',
    });
    assert(result !== undefined);
    expect(result.state.data.__outcome).toBe('failure');
    expect(result.state.checkpoints).toHaveLength(2);
  });
});
