import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import {
  createLayerStateStore,
  initLayers,
  storeLayers,
  workingMemory,
} from '@noetic-tools/memory';
import type { FunctionCallItem } from '@noetic-tools/types';
import { z } from 'zod';
import { makeCtx, makeItemLog, makeScopedStorage, makeStorage } from '../_helpers';

describe('workingMemory layer', () => {
  it('has correct id and slot', () => {
    const layer = workingMemory();
    expect(layer.id).toBe('working-memory');
    expect(layer.slot).toBe(100);
    expect(layer.scope).toBe('thread');
  });

  it('init loads from storage', async () => {
    const storage = makeScopedStorage();
    await storage.set('state', {
      notes: 'hello',
    });
    const layer = workingMemory();
    const result = await layer.hooks.init!({
      storage,
      scopeKey: 'thread-1',
      ctx: makeCtx(),
    });
    expect(result.state).toEqual({
      notes: 'hello',
    });
  });

  it('init defaults to empty string for non-schema mode', async () => {
    const layer = workingMemory();
    const result = await layer.hooks.init!({
      storage: makeScopedStorage(),
      scopeKey: 'thread-1',
      ctx: makeCtx(),
    });
    expect(result.state).toBe('');
  });

  it('recall renders working_memory block', async () => {
    const layer = workingMemory();
    const result = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx: makeCtx(),
      state: {
        notes: 'important',
      },
      budget: 1_000,
    });
    expect(result).not.toBeNull();
    assert(typeof result !== 'string');
    expect(result!.items).toHaveLength(1);
    const msg = result!.items[0];
    assert(msg.type === 'message');
    expect(msg.role).toBe('developer');
    const part = msg.content[0];
    assert(part.type === 'input_text');
    expect(part.text).toContain('<working_memory>');
    expect(part.text).toContain('important');
  });

  it('recall returns null when empty', async () => {
    const layer = workingMemory();
    const result = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx: makeCtx(),
      state: '',
      budget: 1_000,
    });
    expect(result).toBeNull();
  });

  it('recall returns null when empty object', async () => {
    const layer = workingMemory();
    const result = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx: makeCtx(),
      state: {},
      budget: 1_000,
    });
    expect(result).toBeNull();
  });

  it('store watches for updateWorkingMemory', async () => {
    const layer = workingMemory();
    const funcCall: FunctionCallItem = {
      id: 'fc1',
      status: 'completed',
      type: 'function_call',
      callId: 'c1',
      name: 'updateWorkingMemory',
      arguments: '{"notes":"updated"}',
    };
    const result = await layer.hooks.store!({
      newItems: [
        funcCall,
      ],
      log: makeItemLog(),
      response: {
        items: [
          funcCall,
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      ctx: makeCtx(),
      state: {
        existing: true,
      },
    });
    assert(result !== undefined);
    assert(typeof result.state !== 'string');
    expect(result.state.notes).toBe('updated');
    expect(result.state.existing).toBe(true); // shallow merged via spread
  });

  it('store does not update in readOnly mode', async () => {
    const layer = workingMemory({
      readOnly: true,
    });
    const funcCall: FunctionCallItem = {
      id: 'fc1',
      status: 'completed',
      type: 'function_call',
      callId: 'c1',
      name: 'updateWorkingMemory',
      arguments: '{"notes":"updated"}',
    };
    const result = await layer.hooks.store!({
      newItems: [
        funcCall,
      ],
      log: makeItemLog(),
      response: {
        items: [
          funcCall,
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      ctx: makeCtx(),
      state: {
        existing: true,
      },
    });
    expect(result).toBeUndefined();
  });

  it('onSpawn propagates for resource scope', async () => {
    const layer = workingMemory({
      scope: 'resource',
    });
    const result = await layer.hooks.onSpawn!({
      parentState: {
        data: 'parent',
      },
      childCtx: makeCtx(),
    });
    expect(result!.childState).toEqual({
      data: 'parent',
    });
  });

  it('onSpawn returns null for thread scope', async () => {
    const layer = workingMemory({
      scope: 'thread',
    });
    const result = await layer.hooks.onSpawn!({
      parentState: {
        data: 'parent',
      },
      childCtx: makeCtx(),
    });
    expect(result).toBeNull();
  });

  it('store deep-merges nested objects (sibling keys preserved)', async () => {
    const layer = workingMemory();
    const funcCall: FunctionCallItem = {
      id: 'fc1',
      status: 'completed',
      type: 'function_call',
      callId: 'c1',
      name: 'updateWorkingMemory',
      arguments: '{"nested":{"a":99}}',
    };
    const result = await layer.hooks.store!({
      newItems: [
        funcCall,
      ],
      log: makeItemLog(),
      response: {
        items: [
          funcCall,
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      ctx: makeCtx(),
      state: {
        nested: {
          a: 1,
          b: 2,
        },
      },
    });
    assert(result !== undefined);
    assert(typeof result.state !== 'string');
    // Deep merge: nested object is merged, sibling key b is preserved
    expect(result.state.nested).toEqual({
      a: 99,
      b: 2,
    });
  });

  it('respects custom scope config', () => {
    const layer = workingMemory({
      scope: 'resource',
    });
    expect(layer.scope).toBe('resource');
  });

  describe('schema validation (M6)', () => {
    const CountSchema = z.object({
      count: z.number(),
    });

    function updateFn(layer: ReturnType<typeof workingMemory>) {
      const decl = layer.provides.update;
      assert(decl.kind === 'function');
      return decl;
    }

    it('valid update via the tool passes and merges', async () => {
      const layer = workingMemory({
        schema: CountSchema,
      });
      const outcome = await updateFn(layer).execute(
        {
          count: 2,
        },
        {
          count: 1,
        },
        makeCtx(),
      );
      expect(outcome.state).toEqual({
        count: 2,
      });
    });

    it('invalid update via the tool throws and leaves state untouched', async () => {
      const layer = workingMemory({
        schema: CountSchema,
      });
      const state = {
        count: 1,
      };
      await expect(
        updateFn(layer).execute(
          {
            count: 'not-a-number',
          },
          state,
          makeCtx(),
        ),
      ).rejects.toThrow('working-memory update rejected by schema');
      // The prior state object is untouched (gate, not mutation).
      expect(state).toEqual({
        count: 1,
      });
    });

    it('partial update merged over valid state passes (merged state validated)', async () => {
      const layer = workingMemory({
        schema: CountSchema,
      });
      // The update alone would fail the schema (no count); the MERGED state passes.
      const outcome = await updateFn(layer).execute(
        {
          note: 'extra',
        },
        {
          count: 7,
        },
        makeCtx(),
      );
      expect(outcome.state).toEqual({
        count: 7,
        note: 'extra',
      });
    });

    it('legacy store() path rejects schema-violating updates (storeLayers drops + diagnostic)', async () => {
      const layer = workingMemory({
        schema: CountSchema,
      });
      const funcCall: FunctionCallItem = {
        id: 'fc1',
        status: 'completed',
        type: 'function_call',
        callId: 'c1',
        name: 'updateWorkingMemory',
        arguments: '{"count":"bad"}',
      };
      const diagnostics: string[] = [];
      const store = createLayerStateStore((layerId, hook) => {
        diagnostics.push(`${layerId}:${hook}`);
      });
      const ctx = makeCtx({
        executionId: 'exec-wm-schema',
      });
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });
      store.set(ctx.executionId, layer.id, {
        count: 1,
      });
      await storeLayers({
        layers: [
          layer,
        ],
        response: {
          items: [
            funcCall,
          ],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
          },
        },
        ctx,
        log: makeItemLog(),
        store,
      });
      // Update dropped, prior state preserved, diagnostic reported.
      expect(store.get<Record<string, unknown>>(ctx.executionId, layer.id)).toEqual({
        count: 1,
      });
      expect(diagnostics).toContain('working-memory:store');
    });

    it('init falls back to {} when persisted state fails the schema', async () => {
      const storage = makeScopedStorage();
      await storage.set('state', {
        count: 'corrupt',
      });
      const layer = workingMemory({
        schema: CountSchema,
      });
      const result = await layer.hooks.init!({
        storage,
        scopeKey: 'thread-1',
        ctx: makeCtx(),
      });
      expect(result.state).toEqual({});
    });

    it('init keeps persisted state that passes the schema', async () => {
      const storage = makeScopedStorage();
      await storage.set('state', {
        count: 3,
      });
      const layer = workingMemory({
        schema: CountSchema,
      });
      const result = await layer.hooks.init!({
        storage,
        scopeKey: 'thread-1',
        ctx: makeCtx(),
      });
      expect(result.state).toEqual({
        count: 3,
      });
    });

    it('no schema → updates are not validated (regression)', async () => {
      const layer = workingMemory();
      const outcome = await updateFn(layer).execute(
        {
          anything: [
            1,
            2,
          ],
        },
        {},
        makeCtx(),
      );
      expect(outcome.state).toEqual({
        anything: [
          1,
          2,
        ],
      });
    });
  });
});
