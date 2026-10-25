import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { ContextData, ContextLayer } from '@noetic-tools/context';
import {
  beforeToolCallLayers,
  contextToExecCtx,
  createLayerStateStore,
  exportSpans,
  initLayers,
} from '@noetic-tools/context';
import type {
  AgentHarnessContract,
  StepInParallelAll,
  StepInvokeTool,
  StepSpawn,
  TraceExporter,
} from '@noetic-tools/types';
import { SteeringAction } from '@noetic-tools/types';
import { z } from 'zod';
import { AgentHarness } from '../../src/harness/agent-harness';
import { execute } from '../../src/interpreter/execute';
import { executeSpawn } from '../../src/interpreter/execute-action';
import { executeInParallel } from '../../src/interpreter/execute-control';
import { SpanImpl } from '../../src/observability/span-impl';
import { ContextImpl } from '../../src/runtime/context-impl';
import { makeMessage, makeMockHarness, makeStorage, textOnlyResponse } from '../_helpers';

//#region Helpers

/** An exporter that rejects every export, counting the attempts. */
function rejectingExporter(): TraceExporter & {
  attempts: number;
} {
  const exporter = {
    attempts: 0,
    async export(): Promise<void> {
      exporter.attempts += 1;
      throw new Error('backend down');
    },
  };
  return exporter;
}

function brokenTraceContext(): {
  ctx: ContextImpl;
  exporter: ReturnType<typeof rejectingExporter>;
} {
  const exporter = rejectingExporter();
  const base = makeMockHarness();
  const harness: AgentHarnessContract = {
    ...base,
    config: {
      ...base.config,
      approveToolCall: () => ({
        action: SteeringAction.Allow,
      }),
    },
    traceExporter: exporter,
    createSpan: (name, parent) => new SpanImpl(name, parent),
  };
  return {
    ctx: new ContextImpl({
      harness,
      span: new SpanImpl('root', null),
    }),
    exporter,
  };
}

function constant(id: string, value: number): StepSpawn<ContextData, number, number>['child'] {
  return {
    kind: 'runCode',
    id,
    execute: async () => value,
  };
}

function layer(
  id: string,
  hooks: ContextLayer['hooks'],
  extra?: Partial<ContextLayer>,
): ContextLayer {
  return {
    id,
    slot: 100,
    scope: 'execution',
    hooks,
    ...extra,
  };
}

let warn: ReturnType<typeof spyOn>;

/** Warnings that report a failed trace export. */
function exportWarnings(): unknown[][] {
  return warn.mock.calls.filter((args: unknown[]) =>
    String(args[0]).includes('trace export failed'),
  );
}

//#endregion

describe('trace export failures', () => {
  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('exportSpans reports a rejection once and resolves', async () => {
    const exporter = rejectingExporter();

    await exportSpans(exporter, [
      new SpanImpl('x', null),
    ]);

    expect(exporter.attempts).toBe(1);
    expect(exportWarnings()).toHaveLength(1);
  });

  it('exportSpans swallows an exporter that throws synchronously', async () => {
    await exportSpans(
      {
        export: () => {
          throw new Error('sync');
        },
      },
      [],
    );

    expect(exportWarnings()).toHaveLength(1);
  });

  it('does not fail a layer hook', async () => {
    const { ctx } = brokenTraceContext();
    const diagnostics: string[] = [];
    const store = createLayerStateStore((layerId, hook) => diagnostics.push(`${layerId}:${hook}`));

    await initLayers({
      layers: [
        layer('notes', {
          init: async () => ({
            state: 'ready',
          }),
        }),
      ],
      ctx: contextToExecCtx(ctx),
      storage: makeStorage(),
      store,
    });

    expect(store.get(ctx.id, 'notes')).toBe('ready');
    expect(store.isDisabled?.(ctx.id, 'notes') ?? false).toBe(false);
    expect(diagnostics).toEqual([]);
    expect(exportWarnings()).toHaveLength(1);
  });

  it('keeps a gating beforeToolCall that allowed the call allowing it', async () => {
    const { ctx } = brokenTraceContext();

    const decision = await beforeToolCallLayers({
      layers: [
        layer(
          'gate',
          {
            beforeToolCall: async () => ({
              decision: {
                action: SteeringAction.Allow,
              },
            }),
          },
          {
            onBeforeToolCallError: 'deny',
          },
        ),
      ],
      toolName: 'shell',
      toolArgs: {},
      ctx: contextToExecCtx(ctx),
      store: createLayerStateStore(),
    });

    expect(decision.action).toBe(SteeringAction.Allow);
    expect(exportWarnings()).toHaveLength(1);
  });

  it('does not fail a spawn', async () => {
    const { ctx, exporter } = brokenTraceContext();
    const step: StepSpawn<ContextData, number, number> = {
      kind: 'spawn',
      id: 'child',
      child: constant('seven', 7),
    };

    expect(await executeSpawn(step, 0, ctx, execute)).toBe(7);
    expect(exporter.attempts).toBe(1);
    expect(exportWarnings()).toHaveLength(1);
  });

  it('does not fail an inParallel path', async () => {
    const { ctx, exporter } = brokenTraceContext();
    const step: StepInParallelAll<ContextData, number, number> = {
      kind: 'inParallel',
      id: 'fan-out',
      mode: 'all',
      paths: () => [
        constant('one', 1),
        constant('two', 2),
      ],
      merge: (results) => results.reduce((a, b) => a + b, 0),
    };

    expect(await executeInParallel(step, 0, ctx, execute)).toBe(3);
    expect(exporter.attempts).toBe(2);
    expect(exportWarnings()).toHaveLength(2);
  });

  it('does not fail an invokeTool call', async () => {
    const { ctx, exporter } = brokenTraceContext();
    const step: StepInvokeTool<
      Record<string, never>,
      {
        text: string;
      },
      string
    > = {
      kind: 'invokeTool',
      id: 'echo-step',
      tool: {
        name: 'echo',
        description: 'Echo the text',
        input: z.object({
          text: z.string(),
        }),
        output: z.string(),
        execute: async ({ text }) => text,
      },
    };

    expect(
      await execute(
        step,
        {
          text: 'hi',
        },
        ctx,
      ),
    ).toBe('hi');
    expect(exporter.attempts).toBe(1);
    expect(exportWarnings()).toHaveLength(1);
  });

  it('does not fail a model call', async () => {
    const exporter = rejectingExporter();
    const harness = new AgentHarness({
      name: 'broken-trace',
      params: {},
      traceExporter: exporter,
      _testCallModel: async () => textOnlyResponse('hi'),
    });

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'hello'),
      ],
    });

    expect(response.items.length).toBeGreaterThan(0);
    expect(exporter.attempts).toBeGreaterThan(0);
    expect(exportWarnings()).toHaveLength(exporter.attempts);
  });
});
