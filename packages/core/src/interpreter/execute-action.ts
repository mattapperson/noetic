/**
 * Action step handlers: run, llm, spawn, provide, tool.
 */

import { ZodError } from 'zod';
import { NoeticErrorImpl } from '../errors/noetic-error';
import { contextToExecCtx } from '../memory/exec-context-factory';
import { resolveLayerTools } from '../memory/layer-api';
import type { LayerStateStore } from '../memory/layer-lifecycle';
import { returnLayers, spawnLayers } from '../memory/layer-lifecycle';
import { commitLayerUsage, computeLayerUsage } from '../memory/layer-usage';
import { assembleView } from '../memory/projector';
import { emitFrameworkEvent, getBroadcaster } from '../runtime/broadcaster-utils';
import { ContextImpl } from '../runtime/context-impl';
import { snapshotCwdState } from '../runtime/cwd-helpers';
import { buildToolExecutionContext } from '../runtime/tool-memory';
import type { ItemSchemaRegistry } from '../schemas/item';
import { defaultItemSchemaRegistry } from '../schemas/item';
import type { RetryPolicy, StepMeta } from '../types/common';
import type { Context } from '../types/context';
import type { FunctionCallItem, Item } from '../types/items';
import type { ContextMemory, ExecutionContext, MemoryConfig, MemoryLayer } from '../types/memory';
import type { AgentHarnessContract, RecallLayerOutput } from '../types/runtime';
import { SteeringAction } from '../types/steering';
import type {
  ExecuteStepFn,
  StepLLM,
  StepProvide,
  StepRun,
  StepSpawn,
  StepTool,
} from '../types/step';
import type { Tool } from '../types/tool';
import { frameworkCast } from '../util/framework-cast';
import { createMessage, extractAssistantText } from '../util/message-helpers';
import { cloneWithGuard } from './clone-guard';
import { collectAllTools, deduplicateTools } from './collect-tools';
import { trackUsage } from './message-helpers';
import { getContextChannelStore, isFunctionCall, isMutableContext } from './typeguards';

//#region run

export async function executeRun<TMemory, I, O>(
  step: StepRun<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
): Promise<O> {
  const retry = step.retry;
  const maxAttempts = retry?.maxAttempts ?? 1;

  let lastError = new Error('No attempts executed');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await step.execute(input, ctx);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));

      if (attempt < maxAttempts - 1 && retry) {
        const delay = computeDelay(retry, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw new NoeticErrorImpl({
    kind: 'step_failed',
    stepId: step.id,
    cause: lastError,
    retriesExhausted: maxAttempts > 1,
  });
}

function computeDelay(retry: RetryPolicy, attempt: number): number {
  let delay: number;
  switch (retry.backoff) {
    case 'fixed':
      delay = retry.initialDelay;
      break;
    case 'linear':
      delay = retry.initialDelay * (attempt + 1);
      break;
    case 'exponential':
      delay = retry.initialDelay * 2 ** attempt;
      break;
  }
  return Math.min(delay, retry.maxDelay ?? 30_000);
}

//#endregion

//#region llm

const MAX_STEERING_RETRIES = 3;
const emptyRecall: ReadonlyArray<RecallLayerOutput> = [];

interface ResolvedTools {
  tools: Tool[] | undefined;
  allowedToolNames: string[] | undefined;
}

/**
 * Resolves which tools to send and what restrictions to apply.
 *
 * When a unified tool set exists on the context (collected before execution),
 * every LLM call sends the full set and step.tools narrows via allowedToolNames.
 *
 * Semantics:
 *   step.tools = undefined → unrestricted (all tools, no allowedToolNames)
 *   step.tools = []        → no tools at all
 *   step.tools = [a, b]    → full set sent, restrict to a and b
 *
 * Fallback: when no unified set exists (e.g. harness.run() called directly),
 * merge step tools with layer tools as before.
 */
function resolveToolsAndRestrictions(
  step: StepLLM,
  layers: MemoryLayer[] | undefined,
  ctx: Context,
): ResolvedTools {
  // step.tools = [] → explicit opt-out
  if (step.tools && step.tools.length === 0) {
    return {
      tools: undefined,
      allowedToolNames: undefined,
    };
  }

  const unified = ctx.unifiedTools;
  if (unified && unified.length > 0) {
    const allowedToolNames = step.tools ? step.tools.map((t) => t.name) : undefined;
    return {
      tools: [
        ...unified,
      ],
      allowedToolNames,
    };
  }

  // Fallback: no unified set (direct harness.run() path)
  const layerTools = layers && layers.length > 0 ? resolveLayerTools(layers, ctx.harness, ctx) : [];
  if (layerTools.length === 0 && !step.tools) {
    return {
      tools: undefined,
      allowedToolNames: undefined,
    };
  }
  const merged = [
    ...(step.tools ?? []),
    ...layerTools,
  ];
  return {
    tools: merged.length > 0 ? merged : undefined,
    allowedToolNames: undefined,
  };
}

interface RunInputPipelineParams {
  ctx: Context<ContextMemory>;
  layers: MemoryLayer[];
  input: string;
}

async function runInputPipeline({ ctx, layers, input }: RunInputPipelineParams): Promise<void> {
  const userItem = createMessage(input, 'user');
  const { items: finalItems } = await ctx.harness.runAppendPipeline(
    layers,
    [
      userItem,
    ],
    ctx,
  );
  for (const item of finalItems) {
    ctx.itemLog.append(item);
  }
}

export async function executeLLM<TMemory, I, O>(
  step: StepLLM<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  layers?: MemoryLayer[],
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextMemory>>(ctx);
  const hasLayers = layers !== undefined && layers.length > 0;

  // Append user input — through layer pipeline if layers exist, otherwise direct.
  if (typeof input === 'string' && input.length > 0) {
    if (hasLayers) {
      await runInputPipeline({
        ctx: baseCtx,
        layers,
        input,
      });
    } else {
      baseCtx.itemLog.append(createMessage(input, 'user'));
    }
  }

  const { tools: resolvedTools, allowedToolNames } = resolveToolsAndRestrictions(
    step,
    layers,
    baseCtx,
  );

  // Recall once per LLM step: every layer with a recall hook contributes its
  // current view. Results drive both the assembled context window and the
  // per-layer usage breakdown (ctx.lastLayerUsage). Recall fires before the
  // steering retry loop because retries replay the same context.
  const recallQuery = typeof input === 'string' ? input : '';
  const recallResults = hasLayers
    ? await baseCtx.harness.recallLayers(layers, recallQuery, baseCtx)
    : emptyRecall;
  const layerOutputItems: Item[] = recallResults.flatMap((r) => r.items);

  let retries = 0;

  while (retries <= MAX_STEERING_RETRIES) {
    const rawHistoryItems: ReadonlyArray<Item> = baseCtx.itemLog.items;
    const projectedHistoryItems = hasLayers
      ? await baseCtx.harness.projectHistory(layers, rawHistoryItems, baseCtx)
      : rawHistoryItems;
    const assembledItems =
      layerOutputItems.length > 0
        ? assembleView({
            systemPromptItems: [],
            layerOutputItems,
            historyItems: [
              ...projectedHistoryItems,
            ],
          })
        : projectedHistoryItems === rawHistoryItems
          ? rawHistoryItems
          : [
              ...projectedHistoryItems,
            ];

    const request = resolvedTools
      ? {
          model: step.model,
          items: assembledItems,
          instructions: step.instructions,
          tools: resolvedTools,
          params: step.params,
          outputSchema: step.output,
          emit: step.emit,
          ctx: baseCtx,
          layers,
          allowedToolNames,
        }
      : {
          model: step.model,
          items: assembledItems,
          instructions: step.instructions,
          params: step.params,
          outputSchema: step.output,
          emit: step.emit,
        };
    const response = await baseCtx.harness.callModel(request);

    if (hasLayers) {
      const decision = await baseCtx.harness.afterModelCall(layers, response, baseCtx);

      if (decision.action === SteeringAction.Deny) {
        throw new NoeticErrorImpl({
          kind: 'steering_denied',
          guidance: decision.guidance,
        });
      }

      if (decision.action === SteeringAction.Guide && retries < MAX_STEERING_RETRIES) {
        baseCtx.itemLog.append(
          createMessage(decision.guidance ?? 'Please adjust your response.', 'developer'),
        );
        retries++;
        continue;
      }
    }

    const toolCalls: FunctionCallItem[] = [];
    for (const item of response.items) {
      baseCtx.itemLog.append(item);
      if (isFunctionCall(item)) {
        toolCalls.push(item);
      }
    }

    const meta: StepMeta = {
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: response.usage,
      cost: response.cost,
      responseItems: response.items,
    };

    if (isMutableContext(baseCtx)) {
      baseCtx.lastStepMeta = meta;
    }
    trackUsage(baseCtx, response);

    commitLayerUsage(
      baseCtx,
      computeLayerUsage({
        ctx: baseCtx,
        modelId: step.model,
        instructions: step.instructions,
        tools: resolvedTools,
        recallResults,
      }),
    );

    if (hasLayers) {
      await baseCtx.harness.storeLayers(layers, response, baseCtx);
    }

    const lastText = extractAssistantText(response.items);

    if (step.output) {
      try {
        const parsed = JSON.parse(lastText);
        return step.output.parse(parsed);
      } catch (e) {
        if (e instanceof SyntaxError || e instanceof ZodError) {
          throw new NoeticErrorImpl({
            kind: 'llm_parse_error',
            stepId: step.id,
            raw: lastText,
            schema: step.output,
            zodError:
              e instanceof ZodError
                ? e
                : new ZodError([
                    {
                      code: 'custom',
                      message: `Invalid JSON: ${e.message}`,
                      path: [],
                    },
                  ]),
          });
        }
        throw e;
      }
    }

    return frameworkCast<O>(lastText);
  }

  // Safety net: the loop above always returns or throws within the body.
  // This throw is unreachable but protects against future refactors that
  // might break the loop invariant.
  throw new NoeticErrorImpl({
    kind: 'step_failed',
    stepId: step.id,
    cause: new Error('Steering retries exhausted'),
    retriesExhausted: true,
  });
}

//#endregion

//#region spawn

export interface ExecuteSpawnOpts {
  layerStore?: LayerStateStore;
  parentLayers?: MemoryLayer[];
  itemSchemas?: ItemSchemaRegistry;
}

interface CollectSpawnItemsParams {
  layers: MemoryLayer[];
  parentExecutionCtx: ExecutionContext;
  childExecutionCtx: ExecutionContext;
  layerStore: LayerStateStore;
  itemSchemas?: ItemSchemaRegistry;
}

function isMemoryConfig(value: unknown): value is MemoryConfig {
  return typeof value === 'object' && value !== null && 'layers' in value;
}

function resolveLayersForSpawn<TMemory, I, O>(
  step: StepSpawn<TMemory, I, O>,
  parentLayers?: MemoryLayer[],
): MemoryLayer[] {
  if (!step.memory) {
    return parentLayers ?? [];
  }
  if (isMemoryConfig(step.memory)) {
    return [
      ...step.memory.layers,
    ];
  }
  return step.memory;
}

async function collectSpawnItems({
  layers,
  parentExecutionCtx,
  childExecutionCtx,
  layerStore,
  itemSchemas = defaultItemSchemaRegistry,
}: CollectSpawnItemsParams): Promise<Item[]> {
  const spawnResults = await spawnLayers({
    layers,
    parentCtx: parentExecutionCtx,
    childCtx: childExecutionCtx,
    store: layerStore,
    itemSchemas,
  });

  return spawnResults.flatMap((r) => r.items);
}

export async function executeSpawn<TMemory, I, O>(
  step: StepSpawn<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  executeStep: ExecuteStepFn,
  opts?: ExecuteSpawnOpts,
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextMemory>>(ctx);
  const layers = resolveLayersForSpawn(step, opts?.parentLayers);
  const childId = crypto.randomUUID();
  const childExecutionCtx = contextToExecCtx(baseCtx, {
    executionId: childId,
    depth: baseCtx.depth + 1,
    stepNumber: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    cost: 0,
    readLayerStateId: childId,
  });
  const layerStore = opts?.layerStore;
  const hasLayers = layers.length > 0 && layerStore !== undefined;

  // Collect items from memory layers via onSpawn hooks
  let childItems: Item[] = [];
  let parentExecutionCtx: ExecutionContext | undefined;
  if (hasLayers) {
    parentExecutionCtx = contextToExecCtx(baseCtx);
    childItems = await collectSpawnItems({
      layers,
      parentExecutionCtx,
      childExecutionCtx,
      layerStore,
      itemSchemas: opts?.itemSchemas,
    });
  }

  // Build unified tool set for child from its step tree + layers
  const childStepTools = collectAllTools(step.child);
  const childLayerTools =
    layers.length > 0 ? resolveLayerTools(layers, baseCtx.harness, baseCtx) : [];
  const childUnifiedTools = deduplicateTools([
    ...childStepTools,
    ...childLayerTools,
  ]);

  // Create child context — empty by default, layers provide items via onSpawn.
  const childCtx = new ContextImpl({
    harness: baseCtx.harness,
    parent: baseCtx,
    items: childItems,
    state: cloneWithGuard(baseCtx.state, `Spawn '${step.id}'`),
    threadId: baseCtx.threadId,
    resourceId: baseCtx.resourceId,
    channelStore: getContextChannelStore(baseCtx),
    layers: layers.length > 0 ? layers : undefined,
    unifiedTools: childUnifiedTools.length > 0 ? childUnifiedTools : undefined,
    cwdState: snapshotCwdState(baseCtx),
  });

  try {
    // Execute the child step
    const childOutput = await executeStep<TMemory, I, O>(
      step.child,
      input,
      frameworkCast<Context<TMemory>>(childCtx),
    );

    // Pipeline result through layer onReturn hooks
    if (!hasLayers || !parentExecutionCtx) {
      return childOutput;
    }

    const pipelinedResult = await returnLayers({
      layers,
      parentCtx: parentExecutionCtx,
      childCtx: childExecutionCtx,
      childLog: childCtx.itemLog,
      result: childOutput,
      store: layerStore,
    });
    return pipelinedResult;
  } finally {
    // Clean up child execution state to prevent memory leaks — runs on success and error
    if (hasLayers) {
      layerStore.cleanup(childExecutionCtx.executionId);
    }
  }
}

//#endregion

//#region provide

function resolveLayers<TMemory, I, O>(step: StepProvide<TMemory, I, O>): MemoryLayer[] {
  if (isMemoryConfig(step.memory)) {
    return [
      ...step.memory.layers,
    ];
  }
  return step.memory;
}

function mergeLayers(existing: MemoryLayer[] | undefined, provided: MemoryLayer[]): MemoryLayer[] {
  if (!existing || existing.length === 0) {
    return provided;
  }

  // Provided layers override existing layers with the same id (like nested React context)
  const providedIds = new Set(provided.map((l) => l.id));
  const kept = existing.filter((l) => !providedIds.has(l.id));
  return [
    ...kept,
    ...provided,
  ];
}

/**
 * Executes a provide step by attaching memory layers to the current context
 * without creating an isolated child context.
 *
 * Unlike spawn, provide does not create a new itemLog or clone state.
 * Events flow through to the parent in real-time.
 */
export async function executeProvide<TMemory, I, O>(
  step: StepProvide<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const baseCtx = frameworkCast<
    Context<ContextMemory> & {
      layers?: MemoryLayer[];
      unifiedTools?: ReadonlyArray<Tool>;
    }
  >(ctx);
  const previousLayers = baseCtx.layers;
  const previousUnifiedTools = baseCtx.unifiedTools;
  const newLayers = resolveLayers(step);
  const mergedLayers = mergeLayers(previousLayers, newLayers);

  // Attach layers to the current context (no isolation)
  baseCtx.layers = mergedLayers;

  // Merge new layer-provided tools into the unified tool set
  if (baseCtx.unifiedTools && newLayers.length > 0) {
    const layerTools = resolveLayerTools(newLayers, baseCtx.harness, baseCtx);
    if (layerTools.length > 0) {
      baseCtx.unifiedTools = deduplicateTools([
        ...baseCtx.unifiedTools,
        ...layerTools,
      ]);
    }
  }

  try {
    return await executeStep<TMemory, I, O>(step.child, input, ctx);
  } finally {
    // Restore previous layers and unified tools so siblings are not affected
    baseCtx.layers = previousLayers;
    baseCtx.unifiedTools = previousUnifiedTools;
  }
}

//#endregion

//#region tool

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return Symbol.asyncIterator in value;
}

async function consumeToolGenerator(params: {
  generator: AsyncGenerator<unknown, unknown>;
  stepId: string;
  toolName: string;
  ctx: Context<ContextMemory>;
}): Promise<unknown> {
  const broadcaster = getBroadcaster(params.ctx);
  const agentName = params.ctx.harness.config.name;

  while (true) {
    const next = await params.generator.next();
    if (next.done) {
      return next.value;
    }

    emitFrameworkEvent({
      broadcaster,
      agentName,
      eventType: 'tool_progress',
      data: {
        stepId: params.stepId,
        toolName: params.toolName,
        event: next.value,
      },
    });
  }
}

export async function executeTool<TMemory, I, O>(
  step: StepTool<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  harness: AgentHarnessContract,
  layers?: MemoryLayer[],
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextMemory>>(ctx);
  const args = step.args ? Object.assign({}, input, step.args) : input;

  const parseResult = step.tool.input.safeParse(args);
  if (!parseResult.success) {
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: new Error(`Tool input validation failed: ${parseResult.error.message}`),
      retriesExhausted: false,
    });
  }

  if (layers && layers.length > 0) {
    const decision = await harness.beforeToolCall(
      layers,
      step.tool.name,
      parseResult.data,
      baseCtx,
    );
    if (decision.action !== SteeringAction.Allow) {
      throw new NoeticErrorImpl({
        kind: 'steering_denied',
        guidance: decision.guidance,
      });
    }
  }

  try {
    const toolCtx = buildToolExecutionContext(baseCtx, harness);
    const result = step.tool.execute(parseResult.data, toolCtx);

    if (isAsyncGenerator(result)) {
      return frameworkCast<O>(
        await consumeToolGenerator({
          generator: result,
          stepId: step.id,
          toolName: step.tool.name,
          ctx: baseCtx,
        }),
      );
    }

    return frameworkCast<O>(await result);
  } catch (e) {
    if (e instanceof NoeticErrorImpl) {
      throw e;
    }
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: e instanceof Error ? e : new Error(String(e)),
      retriesExhausted: false,
    });
  }
}

//#endregion
