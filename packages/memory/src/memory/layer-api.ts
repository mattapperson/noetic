import type {
  AgentHarnessContract,
  Context,
  ContextMemory,
  LayerFunctionDecl,
  MemoryLayer,
  Tool,
  ToolExecutionContext,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { contextToExecCtx } from './exec-context-factory';

//#region Helpers

interface ExecLayerFnParams {
  fn: LayerFunctionDecl;
  args: unknown;
  layerId: string;
  harness: AgentHarnessContract;
  ctx: Context;
}

function executeLayerFn(params: ExecLayerFnParams): Promise<unknown> {
  const { fn, args, layerId, harness, ctx } = params;
  const validated = fn.input.parse(args);
  const state = harness.getLayerState(ctx.id, layerId);
  const execCtx = contextToExecCtx(ctx);
  return fn.execute(validated, state, execCtx).then((outcome) => {
    if (outcome.state !== undefined) {
      harness.setLayerState(ctx.id, layerId, outcome.state);
    }
    return outcome.result;
  });
}

function buildLayerHandle(layer: MemoryLayer, ctx: Context): Readonly<Record<string, unknown>> {
  const provides = layer.provides;
  if (!provides) {
    return {};
  }

  const handle: Record<string, unknown> = {};
  const harness = ctx.harness;
  const layerId = layer.id;

  for (const [name, decl] of Object.entries(provides)) {
    if (decl.kind === 'data') {
      Object.defineProperty(handle, name, {
        get(): unknown {
          const state = harness.getLayerState(ctx.id, layerId);
          return decl.read(state);
        },
        enumerable: true,
      });
      continue;
    }

    handle[name] = (args: unknown): Promise<unknown> =>
      executeLayerFn({
        fn: decl,
        args,
        layerId,
        harness,
        ctx,
      });
  }

  return handle;
}

//#endregion

//#region Context Memory

/**
 * Build the `ctx.memory` object — a readonly map of layer ID → resolved handle.
 * Handles use getters for data (live reads) and closures for functions (lazy state).
 */
export function buildContextMemory(
  layers: ReadonlyArray<MemoryLayer>,
  ctx: Context,
): ContextMemory {
  const memory: Record<string, Record<string, unknown>> = {};

  for (const layer of layers) {
    memory[layer.id] = buildLayerHandle(layer, ctx);
  }

  return frameworkCast<ContextMemory>(memory);
}

//#endregion

//#region Layer Tools Resolution

/**
 * Collect all `provides` function declarations from active layers and convert them to Tools.
 * Tool names are namespaced as `layerId/functionName`.
 */
export function resolveLayerTools(
  layers: ReadonlyArray<MemoryLayer>,
  harness: AgentHarnessContract,
  ctx: Context,
): Tool[] {
  const tools: Tool[] = [];

  for (const layer of layers) {
    if (!layer.provides) {
      continue;
    }

    for (const [name, decl] of Object.entries(layer.provides)) {
      if (decl.kind !== 'function') {
        continue;
      }

      const layerId = layer.id;

      tools.push({
        name: `${layerId}/${name}`,
        description: decl.description,
        input: decl.input,
        output: decl.output,
        execute: (args: unknown, _toolCtx: ToolExecutionContext): Promise<unknown> =>
          executeLayerFn({
            fn: decl,
            args,
            layerId,
            harness,
            ctx,
          }),
      });
    }
  }

  return tools;
}

//#endregion
