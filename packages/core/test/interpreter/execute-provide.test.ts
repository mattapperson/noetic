import { describe, expect, it } from 'bun:test';
import type { ContextData, ContextLayer } from '@noetic-tools/context';
import { createLayerStateStore, Slot } from '@noetic-tools/context';
import type { Context, ExecuteStepFn, StepWithContext } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import type { ExecuteWithContextOpts } from '../../src/interpreter/execute-action';
import { executeWithContext } from '../../src/interpreter/execute-action';
import { ContextImpl } from '../../src/runtime/context-impl';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
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
      execute?: (input: I, ctx: Context<TContext>) => unknown;
    },
    input: I,
    c: Context<TContext>,
  ): Promise<O> => {
    if (s.kind === 'withContext') {
      return executeWithContext(frameworkCast<StepWithContext<TContext, I, O>>(s), input, c, fn);
    }
    if (s.kind === 'runCode' && s.execute) {
      return frameworkCast<O>(await s.execute(input, c));
    }
    throw new Error(`Unsupported: ${s.kind}`);
  };
  return fn;
}

/** A layer that logs its lifecycle hooks and holds `{ id }` as state. */
function loggingLayer(id: string, log: string[]): ContextLayer {
  return makeLayer(id, {
    hooks: {
      init: async () => {
        log.push(`init:${id}`);
        return {
          state: {
            id,
          },
        };
      },
      dispose: async () => {
        log.push(`dispose:${id}`);
      },
    },
  });
}

function lifecycleOpts(): Required<ExecuteWithContextOpts> {
  return {
    layerStore: createLayerStateStore(),
    storage: createInMemoryStorage(),
  };
}

/** Like `provideExecute`, but every nested withContext gets the same store. */
function lifecycleExecute(opts: ExecuteWithContextOpts): ExecuteStepFn {
  const fn: ExecuteStepFn = async <TContext, I, O>(
    s: {
      kind: string;
      id: string;
      execute?: (input: I, ctx: Context<TContext>) => unknown;
    },
    input: I,
    c: Context<TContext>,
  ): Promise<O> => {
    if (s.kind === 'withContext') {
      return executeWithContext(
        frameworkCast<StepWithContext<TContext, I, O>>(s),
        input,
        c,
        fn,
        opts,
      );
    }
    if (s.kind === 'runCode' && s.execute) {
      return frameworkCast<O>(await s.execute(input, c));
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
        context: [
          layer,
        ],
      };

      await executeWithContext(step, 'input', ctx, simpleExecute);
      expect(receivedLayers).toHaveLength(1);
      expect(receivedLayers![0].id).toBe('config-layer');
    });
  });

  describe('scoped layer lifecycle', () => {
    it('inits provided layers on entry and disposes them on exit', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const opts = lifecycleOpts();
      const log: string[] = [];
      let stateInChild: unknown;
      const step = makeProvideStep(
        'scoped',
        async (_input, childCtx) => {
          log.push('child');
          stateInChild = opts.layerStore.get(childCtx.id, 'scoped');
          childCtx.itemLog.append(makeMessage('assistant', 'ran', 'c1'));
          return 'done';
        },
        [
          loggingLayer('scoped', log),
        ],
      );

      await executeWithContext(step, 'input', ctx, simpleExecute, opts);

      expect(log).toEqual([
        'init:scoped',
        'child',
        'dispose:scoped',
      ]);
      expect(stateInChild).toEqual({
        id: 'scoped',
      });
      expect(opts.layerStore.has?.(ctx.id, 'scoped')).toBe(false);
      expect(ctx.itemLog.items).toHaveLength(1);
    });

    it('leaves the parent layers and their state alone', async () => {
      const log: string[] = [];
      const parent = loggingLayer('parent', log);
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
        layers: [
          parent,
        ],
      });
      const opts = lifecycleOpts();
      opts.layerStore.set(ctx.id, 'parent', {
        id: 'parent',
      });
      const step = makeProvideStep('scoped', async () => 'done', [
        loggingLayer('scoped', log),
      ]);

      await executeWithContext(step, 'input', ctx, simpleExecute, opts);

      expect(log).toEqual([
        'init:scoped',
        'dispose:scoped',
      ]);
      expect(opts.layerStore.get(ctx.id, 'parent')).toEqual({
        id: 'parent',
      });
      expect(ctx.layers).toEqual([
        parent,
      ]);
    });

    it('disposes provided layers when the child throws', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const opts = lifecycleOpts();
      const log: string[] = [];
      const step = makeProvideStep('scoped-throw', async () => {
        throw new Error('child error');
      }, [
        loggingLayer('scoped', log),
      ]);

      await expect(executeWithContext(step, 'input', ctx, simpleExecute, opts)).rejects.toThrow(
        'child error',
      );
      expect(log).toEqual([
        'init:scoped',
        'dispose:scoped',
      ]);
      expect(opts.layerStore.has?.(ctx.id, 'scoped')).toBe(false);
    });

    it('does not init or dispose a layer that overrides a parent id', async () => {
      const log: string[] = [];
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const opts = lifecycleOpts();
      const outer: StepWithContext<ContextData, string, string> = {
        kind: 'withContext',
        id: 'outer',
        child: {
          kind: 'withContext',
          id: 'inner',
          child: {
            kind: 'runCode',
            id: 'capture',
            execute: async () => {
              log.push('child');
              return 'done';
            },
          },
          context: [
            loggingLayer('shared', log),
          ],
        },
        context: [
          loggingLayer('shared', log),
        ],
      };

      await executeWithContext(outer, 'input', ctx, lifecycleExecute(opts), opts);

      // Only the outer boundary owns the `shared` state slot.
      expect(log).toEqual([
        'init:shared',
        'child',
        'dispose:shared',
      ]);
    });

    it('skips init without a layer store', async () => {
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const log: string[] = [];
      const step = makeProvideStep('no-store', async () => 'done', [
        loggingLayer('scoped', log),
      ]);

      await executeWithContext(step, 'input', ctx, simpleExecute);

      expect(log).toEqual([]);
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
