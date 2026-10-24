import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type {
  AgentHarnessContract,
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
import { makeMockHarness } from '../_helpers';

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
