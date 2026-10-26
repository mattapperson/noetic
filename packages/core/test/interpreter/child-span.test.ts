import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import { createLayerStateStore, Slot } from '@noetic-tools/context';
import type {
  AgentHarnessContract,
  Context,
  StepInParallelAll,
  StepInParallelRace,
  StepLoop,
  StepSpawn,
} from '@noetic-tools/types';
import { isNoeticError, NoeticErrorImpl } from '@noetic-tools/types';
import { loop } from '../../src/builders/loop-builder';
import { execute } from '../../src/interpreter/execute';
import { executeSpawn } from '../../src/interpreter/execute-action';
import { executeInParallel } from '../../src/interpreter/execute-control';
import { NoeticAttr, NoeticEvent } from '../../src/observability/genai-attributes';
import { SpanImpl } from '../../src/observability/span-impl';
import { InMemoryExporter } from '../../src/observability/trace-exporter';
import { ContextImpl } from '../../src/runtime/context-impl';
import { until } from '../../src/until/predicates';
import { makeLayer, makeMockHarness, sleep } from '../_helpers';

//#region Helpers

function tracedContext(): {
  ctx: ContextImpl;
  root: SpanImpl;
  exporter: InMemoryExporter;
} {
  const exporter = new InMemoryExporter();
  const harness: AgentHarnessContract = {
    ...makeMockHarness(),
    traceExporter: exporter,
    createSpan: (name, parent) => new SpanImpl(name, parent),
  };
  const root = new SpanImpl('root', null);
  return {
    ctx: new ContextImpl({
      harness,
      span: root,
    }),
    root,
    exporter,
  };
}

function countingLoop(id: string, iterations: number): StepLoop<ContextData, number, number> {
  return loop<ContextData, number, number>({
    id,
    steps: [
      {
        kind: 'runCode',
        id: `${id}-inc`,
        execute: async (input: number) => input + 1,
      },
    ],
    until: until.maxSteps(iterations),
  });
}

function verdictLoops(span: SpanImpl): unknown[] {
  return span.events
    .filter((e) => e.name === NoeticEvent.LOOP_VERDICT)
    .map((e) => e.attributes?.loop);
}

function failing(id: string): StepLoop<ContextData, number, number>['steps'][number] {
  return {
    kind: 'runCode',
    id,
    execute: async () => {
      throw new NoeticErrorImpl({
        kind: 'step_failed',
        stepId: id,
        cause: new Error('boom'),
        retriesExhausted: false,
      });
    },
  };
}

//#endregion

describe('inParallel path spans', () => {
  it('gives each path a span under the enclosing span that carries its loop verdicts', async () => {
    const { ctx, root, exporter } = tracedContext();
    const step: StepInParallelAll<ContextData, number, number> = {
      kind: 'inParallel',
      id: 'fan-out',
      mode: 'all',
      paths: () => [
        countingLoop('left', 2),
        countingLoop('right', 1),
      ],
      merge: (results) => results.reduce((a, b) => a + b, 0),
    };

    const result = await executeInParallel(step, 0, ctx, execute);

    expect(result).toBe(3);
    const spans = exporter.getSpansByName('inParallel.path');
    expect(spans).toHaveLength(2);
    const [left, right] = spans.sort(
      (a, b) =>
        Number(a.attributes.get(NoeticAttr.PARALLEL_INDEX)) -
        Number(b.attributes.get(NoeticAttr.PARALLEL_INDEX)),
    );
    for (const span of spans) {
      expect(span.parentSpanId).toBe(root.spanId);
      expect(span.traceId).toBe(root.traceId);
      expect(span.endTime).toBeDefined();
      expect(span.attributes.get(NoeticAttr.PARALLEL_ID)).toBe('fan-out');
      expect(span.attributes.has('error')).toBe(false);
    }
    expect(left.attributes.get(NoeticAttr.NODE_ID)).toBe('left');
    expect(right.attributes.get(NoeticAttr.NODE_ID)).toBe('right');
    expect(verdictLoops(left)).toEqual([
      'left',
      'left',
    ]);
    expect(verdictLoops(right)).toEqual([
      'right',
    ]);
    expect(verdictLoops(root)).toEqual([]);
  });

  it('marks a failed path as an error and a skipped sibling as cancelled', async () => {
    const { ctx, exporter } = tracedContext();
    const step: StepInParallelAll<ContextData, number, number> = {
      kind: 'inParallel',
      id: 'fail-fast',
      mode: 'all',
      concurrency: 1,
      paths: () => [
        failing('broken'),
        countingLoop('skipped', 1),
      ],
      merge: (results) => results.reduce((a, b) => a + b, 0),
    };

    try {
      await executeInParallel(step, 0, ctx, execute);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('fork_partial');
    }

    const byNode = new Map(
      exporter.getSpansByName('inParallel.path').map((s) => [
        s.attributes.get(NoeticAttr.NODE_ID),
        s,
      ]),
    );
    const broken = byNode.get('broken');
    const skipped = byNode.get('skipped');
    assert(broken && skipped);
    expect(broken.endTime).toBeDefined();
    expect(broken.attributes.get('error')).toBe(true);
    expect(broken.attributes.get(NoeticAttr.ERROR_KIND)).toBe('step_failed');
    expect(skipped.endTime).toBeDefined();
    expect(skipped.attributes.get(NoeticAttr.ERROR_KIND)).toBe('cancelled');
    expect(skipped.attributes.has('error')).toBe(false);
    expect(verdictLoops(skipped)).toEqual([]);
  });

  it('ends the span of a race path that never started', async () => {
    const { ctx, exporter } = tracedContext();
    const step: StepInParallelRace<ContextData, number, number> = {
      kind: 'inParallel',
      id: 'race',
      mode: 'race',
      concurrency: 1,
      paths: () => [
        countingLoop('winner', 1),
        countingLoop('never-ran', 1),
      ],
    };

    expect(await executeInParallel(step, 0, ctx, execute)).toBe(1);

    const spans = exporter.getSpansByName('inParallel.path');
    expect(spans).toHaveLength(2);
    const winner = spans.find((s) => s.attributes.get(NoeticAttr.NODE_ID) === 'winner');
    const neverRan = spans.find((s) => s.attributes.get(NoeticAttr.NODE_ID) === 'never-ran');
    assert(winner && neverRan);
    expect(winner.attributes.has(NoeticAttr.ERROR_KIND)).toBe(false);
    expect(neverRan.attributes.get(NoeticAttr.ERROR_KIND)).toBe('cancelled');
    expect(neverRan.endTime).toBeDefined();
  });
});

describe('spawn spans', () => {
  it('gives the child a span under the enclosing span that carries its loop verdicts', async () => {
    const { ctx, root, exporter } = tracedContext();
    const step: StepSpawn<ContextData, number, number> = {
      kind: 'spawn',
      id: 'worker',
      child: countingLoop('inner', 2),
    };

    expect(await executeSpawn(step, 0, ctx, execute)).toBe(2);

    const [span] = exporter.getSpansByName('spawn');
    assert(span);
    expect(span.parentSpanId).toBe(root.spanId);
    expect(span.endTime).toBeDefined();
    expect(span.attributes.get(NoeticAttr.NODE_ID)).toBe('worker');
    expect(span.attributes.has('error')).toBe(false);
    expect(verdictLoops(span)).toEqual([
      'inner',
      'inner',
    ]);
    expect(verdictLoops(root)).toEqual([]);
  });

  it('nests a spawn inside an inParallel path under the path span', async () => {
    const { ctx, exporter } = tracedContext();
    const step: StepInParallelAll<ContextData, number, number> = {
      kind: 'inParallel',
      id: 'fan-out',
      mode: 'all',
      paths: () => [
        {
          kind: 'spawn',
          id: 'worker',
          child: countingLoop('inner', 1),
        },
      ],
      merge: (results) => results[0],
    };

    await executeInParallel(step, 0, ctx, execute);

    const [path] = exporter.getSpansByName('inParallel.path');
    const [spawn] = exporter.getSpansByName('spawn');
    assert(path && spawn);
    expect(spawn.parentSpanId).toBe(path.spanId);
    expect(verdictLoops(spawn)).toEqual([
      'inner',
    ]);
  });

  it('adds spawn.summary_failed to the spawn span when an onReturn hook throws', async () => {
    const { ctx, root, exporter } = tracedContext();
    const layerStore = createLayerStateStore();
    layerStore.set(ctx.id, 'summarizer', {
      active: true,
    });
    const layer = makeLayer('summarizer', {
      slot: Slot.WORKING_MEMORY,
      hooks: {
        onSpawn: async ({ parentState }) => ({
          childState: parentState,
        }),
        onReturn: async () => {
          throw new Error('summarizer down');
        },
      },
    });
    const step: StepSpawn<ContextData, number, number> = {
      kind: 'spawn',
      id: 'summarized',
      child: countingLoop('inner', 1),
      context: [
        layer,
      ],
    };

    expect(
      await executeSpawn(step, 0, ctx, execute, {
        layerStore,
        parentLayers: [
          layer,
        ],
      }),
    ).toBe(1);

    const [span] = exporter.getSpansByName('spawn');
    assert(span);
    const failures = span.events.filter((e) => e.name === NoeticEvent.SPAWN_SUMMARY_FAILED);
    expect(failures.map((e) => e.attributes)).toEqual([
      {
        stepId: 'summarized',
        layerId: 'summarizer',
        message: 'summarizer down',
      },
    ]);
    expect(root.events.some((e) => e.name === NoeticEvent.SPAWN_SUMMARY_FAILED)).toBe(false);

    // onSpawn runs for the parent, onReturn for the child's spawn span.
    const hookParents = exporter.getSpansByName(NoeticEvent.LAYER_HOOK).map((s) => [
      s.attributes.get(NoeticAttr.LAYER_HOOK),
      s.parentSpanId,
      s.attributes.get(NoeticAttr.LAYER_STATUS),
    ]);
    expect(hookParents).toEqual([
      [
        'onSpawn',
        root.spanId,
        'ok',
      ],
      [
        'onReturn',
        span.spanId,
        'error',
      ],
    ]);
  });

  it('opens onParentUpdate spans under the spawn span', async () => {
    const { ctx, exporter } = tracedContext();
    const layerStore = createLayerStateStore();
    layerStore.set(ctx.id, 'plan', 'v1');
    const { promise: heard, resolve } = Promise.withResolvers<void>();
    const layer = makeLayer('plan', {
      hooks: {
        onSpawn: async ({ parentState }) => ({
          childState: parentState,
        }),
        onParentUpdate: async ({ parentState }) => {
          resolve();
          return {
            childState: parentState,
          };
        },
      },
    });
    const step: StepSpawn<ContextData, string, string> = {
      kind: 'spawn',
      id: 'worker',
      child: {
        kind: 'runCode',
        id: 'work',
        execute: async (_input: string, child: Context<ContextData>): Promise<string> => {
          layerStore.set(ctx.id, 'plan', 'v2');
          await heard;
          await sleep(0);
          return String(layerStore.get(child.id, 'plan'));
        },
      },
    };

    expect(
      await executeSpawn(step, '', ctx, execute, {
        layerStore,
        parentLayers: [
          layer,
        ],
      }),
    ).toBe('v2');

    const [spawn] = exporter.getSpansByName('spawn');
    assert(spawn);
    const updates = exporter
      .getSpansByName(NoeticEvent.LAYER_HOOK)
      .filter((s) => s.attributes.get(NoeticAttr.LAYER_HOOK) === 'onParentUpdate');
    expect(
      updates.map((s) => [
        s.parentSpanId,
        s.attributes.get(NoeticAttr.LAYER_STATUS),
      ]),
    ).toEqual([
      [
        spawn.spanId,
        'ok',
      ],
    ]);
  });

  it('ends and exports the span when the child fails', async () => {
    const { ctx, exporter } = tracedContext();
    const step: StepSpawn<ContextData, number, number> = {
      kind: 'spawn',
      id: 'doomed',
      child: failing('doomed-child'),
    };

    try {
      await executeSpawn(step, 0, ctx, execute);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('step_failed');
    }

    const [span] = exporter.getSpansByName('spawn');
    assert(span);
    expect(span.endTime).toBeDefined();
    expect(span.attributes.get('error')).toBe(true);
    expect(span.attributes.get(NoeticAttr.ERROR_KIND)).toBe('step_failed');
  });

  it('records a cancelled child without marking it an error', async () => {
    const { ctx, exporter } = tracedContext();
    const step: StepSpawn<ContextData, number, number> = {
      kind: 'spawn',
      id: 'aborted',
      child: {
        kind: 'runCode',
        id: 'aborted-child',
        execute: async () => {
          ctx.abort('stop');
          throw new NoeticErrorImpl({
            kind: 'cancelled',
            reason: 'stop',
          });
        },
      },
    };

    try {
      await executeSpawn(step, 0, ctx, execute);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('cancelled');
    }

    const [span] = exporter.getSpansByName('spawn');
    assert(span);
    expect(span.endTime).toBeDefined();
    expect(span.attributes.get(NoeticAttr.ERROR_KIND)).toBe('cancelled');
    expect(span.attributes.has('error')).toBe(false);
  });
});
