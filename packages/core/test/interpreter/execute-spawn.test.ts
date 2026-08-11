import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import { createLayerStateStore, Slot } from '@noetic-tools/context';
import type { Context, Item, StepSpawn } from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
import { executeSpawn } from '../../src/interpreter/execute-action';
import { ChannelStore } from '../../src/runtime/channel-store';
import { ContextImpl } from '../../src/runtime/context-impl';
import { getItemId, makeLayer, makeMessage, makeMockHarness, simpleExecute } from '../_helpers';

//#region Helper Functions

function makeSpawnStep<TContext = ContextData, I = unknown, O = unknown>(
  id: string,
  execute: (input: I, ctx: Context<TContext>) => Promise<O>,
  overrides?: Partial<Pick<StepSpawn<TContext, I, O>, 'context' | 'timeout'>>,
): StepSpawn<TContext, I, O> {
  return {
    kind: 'spawn',
    id,
    child: {
      kind: 'runCode',
      id: `${id}-child`,
      execute,
    },
    ...overrides,
  };
}

//#endregion

//#region Tests

describe('executeSpawn', () => {
  describe('default spawn (no memory)', () => {
    it('starts child with empty ItemLog', async () => {
      const parentCtx = new ContextImpl({
        harness: makeMockHarness(),
      });
      parentCtx.itemLog.append(makeMessage('user', 'hello', 'p1'));

      let childItemCount = -1;
      const step = makeSpawnStep<ContextData, string, string>(
        'empty-spawn',
        async (_input, ctx) => {
          childItemCount = ctx.itemLog.items.length;
          return 'done';
        },
      );

      await executeSpawn(step, 'input', parentCtx, simpleExecute);
      expect(childItemCount).toBe(0);
    });
  });

  describe('state isolation', () => {
    it('child gets deep-cloned state', async () => {
      type TestState = {
        count: number;
        nested: {
          val: string;
        };
      };

      const TestStateSchema = z.object({
        count: z.number(),
        nested: z.object({
          val: z.string(),
        }),
      });

      function assertsIsTestState(value: unknown): asserts value is TestState {
        TestStateSchema.parse(value);
      }

      const initialState = {
        count: 0,
        nested: {
          val: 'original',
        },
      } satisfies TestState;

      const parentCtx = new ContextImpl({
        harness: makeMockHarness(),
        state: initialState,
      });

      const step = makeSpawnStep<ContextData, string, string>('state-test', async (_input, ctx) => {
        assertsIsTestState(ctx.state);
        ctx.state.count = 99;
        ctx.state.nested.val = 'modified';
        return 'done';
      });

      await executeSpawn(step, '', parentCtx, simpleExecute);

      assertsIsTestState(parentCtx.state);
      expect(parentCtx.state.count).toBe(0);
      expect(parentCtx.state.nested.val).toBe('original');
    });
  });

  describe('depth', () => {
    it('child depth increments', async () => {
      const parentCtx = new ContextImpl({
        harness: makeMockHarness(),
      });
      let childDepth = -1;

      const step = makeSpawnStep<ContextData, string, string>('depth-test', async (_input, ctx) => {
        childDepth = ctx.depth;
        return 'done';
      });

      await executeSpawn(step, '', parentCtx, simpleExecute);
      expect(parentCtx.depth).toBe(0);
      expect(childDepth).toBe(1);
    });
  });

  describe('child step error', () => {
    it('propagates from executeSpawn', async () => {
      const parentCtx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const step = makeSpawnStep<ContextData, string, string>('error-test', async () => {
        throw new Error('child boom');
      });

      await expect(executeSpawn(step, '', parentCtx, simpleExecute)).rejects.toThrow('child boom');
    });
  });

  describe('context layers with onSpawn', () => {
    it('provides items to child via onSpawn hook', async () => {
      const parentCtx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const layerStore = createLayerStateStore();
      const parentExecId = parentCtx.id;

      // Pre-seed state for the layer so onSpawn can read it
      layerStore.set(parentExecId, 'recall-layer', {
        seeded: true,
      });

      const spawnItem = makeMessage('user', 'from layer', 'spawn-1');
      const layer = makeLayer('recall-layer', {
        slot: Slot.WORKING_MEMORY,
        hooks: {
          onSpawn: async ({ parentState }) => ({
            childState: parentState,
            items: [
              spawnItem,
            ],
          }),
        },
      });

      let childItems: readonly Item[] = [];
      const step = makeSpawnStep<ContextData, string, string>(
        'layer-spawn',
        async (_input, ctx) => {
          childItems = ctx.itemLog.items;
          return 'done';
        },
        {
          context: [
            layer,
          ],
        },
      );

      await executeSpawn(step, 'input', parentCtx, simpleExecute, {
        layerStore,
        parentLayers: [
          layer,
        ],
      });

      expect(childItems).toHaveLength(1);
      const firstItem = childItems[0];
      assert(firstItem !== undefined);
      expect(getItemId(firstItem)).toBe('spawn-1');
    });
  });

  describe('result pipeline through onReturn layers', () => {
    it('transforms result via onReturn hook', async () => {
      const parentCtx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const layerStore = createLayerStateStore();
      const parentExecId = parentCtx.id;

      layerStore.set(parentExecId, 'transform-layer', {
        active: true,
      });

      const layer = makeLayer('transform-layer', {
        slot: Slot.WORKING_MEMORY,
        hooks: {
          onSpawn: async ({ parentState }) => ({
            childState: parentState,
          }),
          onReturn: async ({ parentState, result }) => ({
            parentState,
            result: `transformed:${result}`,
          }),
        },
      });

      const step = makeSpawnStep<ContextData, string, string>(
        'pipeline-test',
        async () => 'raw-output',
        {
          context: [
            layer,
          ],
        },
      );

      const result = await executeSpawn(step, '', parentCtx, simpleExecute, {
        layerStore,
        parentLayers: [
          layer,
        ],
      });

      expect(result).toBe('transformed:raw-output');
    });
  });

  describe('spawn-local memory replaces parent layers', () => {
    it('uses step.context instead of parentLayers', async () => {
      const parentCtx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const layerStore = createLayerStateStore();
      const parentExecId = parentCtx.id;

      const parentLayer = makeLayer('parent-layer', {
        slot: Slot.WORKING_MEMORY,
        hooks: {
          onSpawn: async ({ parentState }) => ({
            childState: parentState,
            items: [
              makeMessage('user', 'from parent', 'parent-item'),
            ],
          }),
        },
      });

      const spawnLayer = makeLayer('spawn-layer', {
        slot: Slot.OBSERVATIONS,
        hooks: {
          onSpawn: async ({ parentState }) => ({
            childState: parentState,
            items: [
              makeMessage('user', 'from spawn', 'spawn-item'),
            ],
          }),
        },
      });

      // Seed state for both layers
      layerStore.set(parentExecId, 'parent-layer', {
        v: 1,
      });
      layerStore.set(parentExecId, 'spawn-layer', {
        v: 2,
      });

      let childItems: readonly Item[] = [];
      const step = makeSpawnStep<ContextData, string, string>(
        'replace-test',
        async (_input, ctx) => {
          childItems = ctx.itemLog.items;
          return 'done';
        },
        {
          context: [
            spawnLayer,
          ],
        },
      );

      await executeSpawn(step, '', parentCtx, simpleExecute, {
        layerStore,
        parentLayers: [
          parentLayer,
        ],
      });

      // Only spawn-layer items should appear, not parent-layer
      expect(childItems).toHaveLength(1);
      const item = childItems[0];
      assert(item !== undefined);
      expect(getItemId(item)).toBe('spawn-item');
    });
  });

  describe('slot-ordered item merging from multiple layers', () => {
    it('merges items sorted by slot number', async () => {
      const parentCtx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const layerStore = createLayerStateStore();
      const parentExecId = parentCtx.id;

      const highSlotLayer = makeLayer('high-slot', {
        slot: Slot.EPISODIC,
        hooks: {
          onSpawn: async ({ parentState }) => ({
            childState: parentState,
            items: [
              makeMessage('user', 'episodic', 'high-item'),
            ],
          }),
        },
      });

      const lowSlotLayer = makeLayer('low-slot', {
        slot: Slot.WORKING_MEMORY,
        hooks: {
          onSpawn: async ({ parentState }) => ({
            childState: parentState,
            items: [
              makeMessage('user', 'working', 'low-item'),
            ],
          }),
        },
      });

      // Seed state
      layerStore.set(parentExecId, 'high-slot', {
        v: 1,
      });
      layerStore.set(parentExecId, 'low-slot', {
        v: 2,
      });

      let childItems: readonly Item[] = [];
      // Pass layers in reverse slot order to verify sorting
      const step = makeSpawnStep<ContextData, string, string>(
        'merge-test',
        async (_input, ctx) => {
          childItems = ctx.itemLog.items;
          return 'done';
        },
        {
          context: [
            highSlotLayer,
            lowSlotLayer,
          ],
        },
      );

      await executeSpawn(step, '', parentCtx, simpleExecute, {
        layerStore,
      });

      expect(childItems).toHaveLength(2);
      const first = childItems[0];
      const second = childItems[1];
      assert(first !== undefined);
      assert(second !== undefined);
      // Lower slot (WORKING_MEMORY=100) should come before higher slot (EPISODIC=300)
      expect(getItemId(first)).toBe('low-item');
      expect(getItemId(second)).toBe('high-item');
    });
  });

  describe('channel store inheritance', () => {
    it('child context inherits channelStore so it can read/write parent channels', async () => {
      const ch = channel<number>('spawn-share', {
        schema: z.number(),
        mode: 'queue',
      });
      const channelStore = new ChannelStore();

      let sendError: unknown = null;
      let received: number | undefined;

      const step: StepSpawn<ContextData, void, void> = {
        kind: 'spawn',
        id: 'channel-spawn',
        child: {
          kind: 'runCode',
          id: 'child',
          execute: async (_input, c) => {
            try {
              c.send(ch, 13);
            } catch (e) {
              sendError = e;
            }
            const v = c.tryRecv(ch);
            received = v ?? undefined;
          },
        },
      };

      const ctx = new ContextImpl({
        harness: makeMockHarness(),
        channelStore,
      });
      await executeSpawn(step, undefined, ctx, simpleExecute);
      expect(sendError).toBeNull();
      assert(received !== undefined);
      expect(received).toBe(13);
    });
  });

  describe('cancellation', () => {
    it("aborting the parent mid-spawn cancels the child's blocked channel recv", async () => {
      const ch = channel<string>('spawn-cancel', {
        schema: z.string(),
        mode: 'queue',
      });
      const channelStore = new ChannelStore();
      let childCtx: Context<ContextData> | undefined;
      const step = makeSpawnStep<ContextData, void, string>('cancel-spawn', async (_input, c) => {
        childCtx = c;
        // Never delivered — only the parent's abort unblocks this.
        return await c.recv(ch, {
          timeout: 30_000,
        });
      });

      const parentCtx = new ContextImpl({
        harness: makeMockHarness(),
        channelStore,
      });
      const running = executeSpawn(step, undefined, parentCtx, simpleExecute);
      // Let the child reach its blocked recv before cancelling.
      await new Promise((r) => setTimeout(r, 10));
      expect(parentCtx.children).toHaveLength(1);

      parentCtx.abort('user pressed stop');

      try {
        await running;
        throw new Error('should have rejected');
      } catch (e) {
        if (!isNoeticError(e)) {
          throw e;
        }
        expect(e.noeticError.kind).toBe('cancelled');
      }
      assert(childCtx !== undefined);
      expect(childCtx.aborted).toBe(true);
      expect(childCtx.abortReason).toBe('user pressed stop');
    });

    it('detaches the child once the spawn settles, so it is not retained', async () => {
      const step = makeSpawnStep<ContextData, void, string>('detach-spawn', async () => 'done');
      const parentCtx = new ContextImpl({
        harness: makeMockHarness(),
      });

      const result = await executeSpawn(step, undefined, parentCtx, simpleExecute);

      expect(result).toBe('done');
      expect(parentCtx.children).toHaveLength(0);
    });
  });
});

//#endregion
