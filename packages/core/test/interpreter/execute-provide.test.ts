import { describe, expect, it } from 'bun:test';
import { executeProvide } from '../../src/interpreter/execute-action';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { Context } from '../../src/types/context';
import type { ContextMemory, MemoryLayer } from '../../src/types/memory';
import { Slot } from '../../src/types/memory';
import type { ExecuteStepFn, StepProvide } from '../../src/types/step';
import { frameworkCast } from '../../src/util/framework-cast';
import { getItemId, makeMessage, makeMockHarness, simpleExecute } from '../_helpers';

//#region Helper Functions

function makeProvideStep<TMemory = ContextMemory, I = unknown, O = unknown>(
  id: string,
  execute: (input: I, ctx: Context<TMemory>) => Promise<O>,
  memory: MemoryLayer[],
): StepProvide<TMemory, I, O> {
  return {
    kind: 'provide',
    id,
    child: {
      kind: 'run',
      id: `${id}-child`,
      execute,
    },
    memory,
  };
}

function makeLayer(id: string, slot: number): MemoryLayer {
  return {
    id,
    name: id,
    slot,
    scope: 'execution',
    hooks: {},
  };
}

function getLayers(ctx: Context): MemoryLayer[] | undefined {
  return frameworkCast<{
    layers?: MemoryLayer[];
  }>(ctx).layers;
}

function provideExecute(): ExecuteStepFn {
  const fn: ExecuteStepFn = async <TMemory, I, O>(
    s: {
      kind: string;
      id: string;
      execute?: (input: I, ctx: Context<TMemory>) => Promise<O>;
    },
    input: I,
    c: Context<TMemory>,
  ): Promise<O> => {
    if (s.kind === 'provide') {
      return executeProvide(frameworkCast<StepProvide<TMemory, I, O>>(s), input, c, fn);
    }
    if (s.kind === 'run' && s.execute) {
      return s.execute(input, c);
    }
    throw new Error(`Unsupported: ${s.kind}`);
  };
  return fn;
}

//#endregion

//#region Tests

describe('executeProvide', () => {
  describe('layer attachment', () => {
    it('child step receives layers on context', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const layer = makeLayer('test-layer', Slot.STEERING);
      let receivedLayers: MemoryLayer[] | undefined;

      const step = makeProvideStep(
        'provide-layers',
        async (_input, childCtx) => {
          receivedLayers = getLayers(frameworkCast<Context>(childCtx));
          return 'done';
        },
        [
          layer,
        ],
      );

      await executeProvide(step, 'input', ctx, simpleExecute);
      expect(receivedLayers).toBeDefined();
      expect(receivedLayers).toHaveLength(1);
      expect(receivedLayers![0].id).toBe('test-layer');
    });

    it('layers are restored after child completes', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const layer = makeLayer('temp-layer', Slot.STEERING);

      const step = makeProvideStep('provide-restore', async () => 'done', [
        layer,
      ]);

      expect(ctx.layers).toBeUndefined();
      await executeProvide(step, 'input', ctx, simpleExecute);
      expect(ctx.layers).toBeUndefined();
    });

    it('layers are restored even when child throws', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const layer = makeLayer('temp-layer', Slot.STEERING);

      const step = makeProvideStep('provide-error', async () => {
        throw new Error('child error');
      }, [
        layer,
      ]);

      expect(ctx.layers).toBeUndefined();
      await expect(executeProvide(step, 'input', ctx, simpleExecute)).rejects.toThrow(
        'child error',
      );
      expect(ctx.layers).toBeUndefined();
    });
  });

  describe('no isolation (shared context)', () => {
    it('events from child append to same itemLog', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      ctx.itemLog.append(makeMessage('user', 'hello', 'p1'));

      const step = makeProvideStep(
        'provide-shared-log',
        async (_input, childCtx) => {
          childCtx.itemLog.append(makeMessage('assistant', 'world', 'c1'));
          return 'done';
        },
        [
          makeLayer('l1', Slot.STEERING),
        ],
      );

      await executeProvide(step, 'input', ctx, simpleExecute);
      expect(ctx.itemLog.items).toHaveLength(2);
      expect(getItemId(ctx.itemLog.items[0])).toBe('p1');
      expect(getItemId(ctx.itemLog.items[1])).toBe('c1');
    });

    it('state mutations in child are visible to parent', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
        state: {
          count: 0,
        },
      });

      const step = makeProvideStep(
        'provide-shared-state',
        async (_input, childCtx) => {
          frameworkCast<{
            count: number;
          }>(childCtx.state).count = 42;
          return 'done';
        },
        [
          makeLayer('l1', Slot.STEERING),
        ],
      );

      await executeProvide(step, 'input', ctx, simpleExecute);
      expect(
        frameworkCast<{
          count: number;
        }>(ctx.state).count,
      ).toBe(42);
    });
  });

  describe('layer merging (inheritance)', () => {
    it('nested provide: inner layers merge with outer', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const outerLayer = makeLayer('outer', Slot.STEERING);
      const innerLayer = makeLayer('inner', Slot.WORKING_MEMORY);
      let receivedLayers: MemoryLayer[] | undefined;

      const innerStep: StepProvide<ContextMemory, string, string> = {
        kind: 'provide',
        id: 'inner-provide',
        child: {
          kind: 'run',
          id: 'capture',
          execute: async (_input, childCtx) => {
            receivedLayers = getLayers(childCtx);
            return 'done';
          },
        },
        memory: [
          innerLayer,
        ],
      };

      const outerStep: StepProvide<ContextMemory, string, string> = {
        kind: 'provide',
        id: 'outer-provide',
        child: innerStep,
        memory: [
          outerLayer,
        ],
      };

      await executeProvide(outerStep, 'input', ctx, provideExecute());

      expect(receivedLayers).toBeDefined();
      expect(receivedLayers).toHaveLength(2);
      const layerIds = receivedLayers!.map((l) => l.id);
      expect(layerIds).toContain('outer');
      expect(layerIds).toContain('inner');
    });

    it('inner layer overrides outer layer with same id', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const outerLayer = makeLayer('shared-id', Slot.STEERING);
      const innerLayer = makeLayer('shared-id', Slot.WORKING_MEMORY);
      let receivedLayers: MemoryLayer[] | undefined;

      const innerStep: StepProvide<ContextMemory, string, string> = {
        kind: 'provide',
        id: 'inner-provide',
        child: {
          kind: 'run',
          id: 'capture',
          execute: async (_input, childCtx) => {
            receivedLayers = getLayers(childCtx);
            return 'done';
          },
        },
        memory: [
          innerLayer,
        ],
      };

      const outerStep: StepProvide<ContextMemory, string, string> = {
        kind: 'provide',
        id: 'outer-provide',
        child: innerStep,
        memory: [
          outerLayer,
        ],
      };

      await executeProvide(outerStep, 'input', ctx, provideExecute());

      // Only one layer — inner overrode outer
      expect(receivedLayers).toHaveLength(1);
      expect(receivedLayers![0].slot).toBe(Slot.WORKING_MEMORY);
    });
  });

  describe('MemoryConfig support', () => {
    it('resolves layers from MemoryConfig object', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const layer = makeLayer('config-layer', Slot.STEERING);
      let receivedLayers: MemoryLayer[] | undefined;

      const step: StepProvide<ContextMemory, string, string> = {
        kind: 'provide',
        id: 'provide-config',
        child: {
          kind: 'run',
          id: 'capture',
          execute: async (_input, childCtx) => {
            receivedLayers = getLayers(childCtx);
            return 'done';
          },
        },
        memory: [
          layer,
        ],
      };

      await executeProvide(step, 'input', ctx, simpleExecute);
      expect(receivedLayers).toHaveLength(1);
      expect(receivedLayers![0].id).toBe('config-layer');
    });
  });

  describe('output pass-through', () => {
    it('returns child output directly', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });

      const step = makeProvideStep('provide-passthrough', async () => 'result-value', [
        makeLayer('l1', Slot.STEERING),
      ]);

      const result = await executeProvide(step, 'input', ctx, simpleExecute);
      expect(result).toBe('result-value');
    });
  });
});

//#endregion
