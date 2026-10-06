import { describe, expect, it } from 'bun:test';
import type { ContextData, ContextLayer } from '@noetic-tools/context';
import { Slot } from '@noetic-tools/context';
import type { Context, ExecuteStepFn, StepWithContext } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { executeWithContext } from '../../src/interpreter/execute-action';
import { ContextImpl } from '../../src/runtime/context-impl';
import { getItemId, makeLayer, makeMessage, makeMockHarness, simpleExecute } from '../_helpers';

//#region Helper Functions

function makeProvideStep<TContext = ContextData, I = unknown, O = unknown>(
  id: string,
  execute: (input: I, ctx: Context<TContext>) => Promise<O>,
  context: ContextLayer[],
): StepWithContext<TContext, I, O> {
  return {
    kind: 'withContext',
    id,
    child: {
      kind: 'runCode',
      id: `${id}-child`,
      execute,
    },
    context,
  };
}

function getLayers(ctx: Context): ContextLayer[] | undefined {
  return frameworkCast<{
    layers?: ContextLayer[];
  }>(ctx).layers;
}

function provideExecute(): ExecuteStepFn {
  const fn: ExecuteStepFn = async <TContext, I, O>(
    s: {
      kind: string;
      id: string;
      execute?: (input: I, ctx: Context<TContext>) => Promise<O>;
    },
    input: I,
    c: Context<TContext>,
  ): Promise<O> => {
    if (s.kind === 'withContext') {
      return executeWithContext(frameworkCast<StepWithContext<TContext, I, O>>(s), input, c, fn);
    }
    if (s.kind === 'runCode' && s.execute) {
      return s.execute(input, c);
    }
    throw new Error(`Unsupported: ${s.kind}`);
  };
  return fn;
}

//#endregion

//#region Tests

describe('executeWithContext', () => {
  describe('layer attachment', () => {
    it('child step receives layers on context', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const layer = makeLayer('test-layer', {
        slot: Slot.STEERING,
      });
      let receivedLayers: ContextLayer[] | undefined;

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

      await executeWithContext(step, 'input', ctx, simpleExecute);
      expect(receivedLayers).toBeDefined();
      expect(receivedLayers).toHaveLength(1);
      expect(receivedLayers![0].id).toBe('test-layer');
    });

    it('layers are restored after child completes', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const layer = makeLayer('temp-layer', {
        slot: Slot.STEERING,
      });

      const step = makeProvideStep('provide-restore', async () => 'done', [
        layer,
      ]);

      expect(ctx.layers).toBeUndefined();
      await executeWithContext(step, 'input', ctx, simpleExecute);
      expect(ctx.layers).toBeUndefined();
    });

    it('layers are restored even when child throws', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const layer = makeLayer('temp-layer', {
        slot: Slot.STEERING,
      });

      const step = makeProvideStep('provide-error', async () => {
        throw new Error('child error');
      }, [
        layer,
      ]);

      expect(ctx.layers).toBeUndefined();
      await expect(executeWithContext(step, 'input', ctx, simpleExecute)).rejects.toThrow(
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
          makeLayer('l1', {
            slot: Slot.STEERING,
          }),
        ],
      );

      await executeWithContext(step, 'input', ctx, simpleExecute);
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
          makeLayer('l1', {
            slot: Slot.STEERING,
          }),
        ],
      );

      await executeWithContext(step, 'input', ctx, simpleExecute);
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
      const outerLayer = makeLayer('outer', {
        slot: Slot.STEERING,
      });
      const innerLayer = makeLayer('inner', {
        slot: Slot.WORKING_MEMORY,
      });
      let receivedLayers: ContextLayer[] | undefined;

      const innerStep: StepWithContext<ContextData, string, string> = {
        kind: 'withContext',
        id: 'inner-provide',
        child: {
          kind: 'runCode',
          id: 'capture',
          execute: async (_input, childCtx) => {
            receivedLayers = getLayers(childCtx);
            return 'done';
          },
        },
        context: [
          innerLayer,
        ],
      };

      const outerStep: StepWithContext<ContextData, string, string> = {
        kind: 'withContext',
        id: 'outer-provide',
        child: innerStep,
        context: [
          outerLayer,
        ],
      };

      await executeWithContext(outerStep, 'input', ctx, provideExecute());

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
      const outerLayer = makeLayer('shared-id', {
        slot: Slot.STEERING,
      });
      const innerLayer = makeLayer('shared-id', {
        slot: Slot.WORKING_MEMORY,
      });
      let receivedLayers: ContextLayer[] | undefined;

      const innerStep: StepWithContext<ContextData, string, string> = {
        kind: 'withContext',
        id: 'inner-provide',
        child: {
          kind: 'runCode',
          id: 'capture',
          execute: async (_input, childCtx) => {
            receivedLayers = getLayers(childCtx);
            return 'done';
          },
        },
        context: [
          innerLayer,
        ],
      };

      const outerStep: StepWithContext<ContextData, string, string> = {
        kind: 'withContext',
        id: 'outer-provide',
        child: innerStep,
        context: [
          outerLayer,
        ],
      };

      await executeWithContext(outerStep, 'input', ctx, provideExecute());

      // Only one layer — inner overrode outer
      expect(receivedLayers).toHaveLength(1);
      expect(receivedLayers![0].slot).toBe(Slot.WORKING_MEMORY);
    });
  });

  describe('ContextConfig support', () => {
    it('resolves layers from ContextConfig object', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const layer = makeLayer('config-layer', {
        slot: Slot.STEERING,
      });
      let receivedLayers: ContextLayer[] | undefined;

      const step: StepWithContext<ContextData, string, string> = {
        kind: 'withContext',
        id: 'provide-config',
        child: {
          kind: 'runCode',
          id: 'capture',
          execute: async (_input, childCtx) => {
            receivedLayers = getLayers(childCtx);
            return 'done';
          },
        },
        context: {
          layers: [
            layer,
          ],
        },
      };

      await executeWithContext(step, 'input', ctx, simpleExecute);
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
        makeLayer('l1', {
          slot: Slot.STEERING,
        }),
      ]);

      const result = await executeWithContext(step, 'input', ctx, simpleExecute);
      expect(result).toBe('result-value');
    });
  });
});

//#endregion
