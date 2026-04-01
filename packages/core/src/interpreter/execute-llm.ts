import { ZodError } from 'zod';
import { NoeticErrorImpl } from '../errors/noetic-error';
import { allocateBudgets } from '../memory/budget';
import { resolveLayerTools } from '../memory/layer-api';
import { assembleView } from '../memory/projector';
import type { StepMeta, Tool } from '../types/common';
import type { Context } from '../types/context';
import type { FunctionCallItem, Item } from '../types/items';
import type { ContextMemory, MemoryLayer, ProjectionPolicy } from '../types/memory';
import { SteeringAction } from '../types/steering';
import type { StepLLM } from '../types/step';
import { frameworkCast } from './framework-cast';
import { createMessage, estimateTokens, extractAssistantText, trackUsage } from './message-helpers';
import { isMutableContext } from './typeguards';

const MAX_STEERING_RETRIES = 3;
const LAYERS_INIT_SENTINEL = '__layers_initialized';

const DEFAULT_PROJECTION: ProjectionPolicy = {
  tokenBudget: 128e3,
  responseReserve: 4e3,
  overflow: 'sliding_window',
};

//#region Helper Functions

function mergeTools(
  stepTools: Tool[] | undefined,
  layers: MemoryLayer[] | undefined,
  ctx: Context,
): Tool[] | undefined {
  const layerTools = layers && layers.length > 0 ? resolveLayerTools(layers, ctx.harness, ctx) : [];
  if (layerTools.length === 0) {
    return stepTools;
  }
  return [
    ...(stepTools ?? []),
    ...layerTools,
  ];
}

function partitionItems(items: ReadonlyArray<Item>): {
  systemItems: Item[];
  historyItems: Item[];
} {
  const systemItems: Item[] = [];
  const historyItems: Item[] = [];

  for (const item of items) {
    if (item.type === 'message' && item.role === 'system') {
      systemItems.push(item);
      continue;
    }
    historyItems.push(item);
  }

  return {
    systemItems,
    historyItems,
  };
}

//#endregion

//#region Public API

export async function executeLLM<TMemory, I, O>(
  step: StepLLM<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  layers?: MemoryLayer[],
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextMemory>>(ctx);

  if (typeof input === 'string' && input.length > 0) {
    baseCtx.itemLog.append(createMessage(input, 'user'));
  }

  const allTools = mergeTools(step.tools, layers, baseCtx);
  const hasLayers = layers !== undefined && layers.length > 0;

  // Memory pipeline setup (once, before retry loop)
  let budgetMap = new Map<string, number>();

  // Resolve projection policy once: step > harness > default
  const policy: ProjectionPolicy =
    step.projection ?? baseCtx.harness.config.projection ?? DEFAULT_PROJECTION;

  if (hasLayers) {
    // Init layers on first LLM call in this execution
    if (!baseCtx.harness.getLayerState(baseCtx.id, LAYERS_INIT_SENTINEL)) {
      const storage = baseCtx.harness.config.storage;
      if (storage) {
        await baseCtx.harness.initLayers(layers, baseCtx, storage);
        baseCtx.harness.setLayerState(baseCtx.id, LAYERS_INIT_SENTINEL, true);
      }
    }

    let systemTokenEstimate = step.system ? estimateTokens(step.system) : 0;
    for (const item of baseCtx.itemLog.items) {
      if (item.type === 'message' && item.role === 'system') {
        for (const part of item.content) {
          if (part.type === 'input_text') {
            systemTokenEstimate += estimateTokens(part.text);
          }
        }
      }
    }
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: policy.tokenBudget,
      systemPromptTokens: systemTokenEstimate,
      responseReserve: policy.responseReserve,
    });
    budgetMap = new Map(
      allocations.map((a) => [
        a.layerId,
        a.allocated,
      ]),
    );
  }

  let retries = 0;

  while (retries <= MAX_STEERING_RETRIES) {
    // Recall + Assemble
    let requestItems: ReadonlyArray<Item>;

    if (hasLayers) {
      const query = typeof input === 'string' ? input : '';

      const atomicResults = await baseCtx.harness.recallLayersAtomic(
        layers,
        query,
        baseCtx,
        budgetMap,
      );
      const eventualResults = await baseCtx.harness.recallLayersEventual(
        layers,
        query,
        baseCtx,
        budgetMap,
      );

      const layerOutputItems = [
        ...atomicResults,
        ...eventualResults,
      ].flatMap((r) => r.items);

      const { systemItems, historyItems } = partitionItems(baseCtx.itemLog.items);

      requestItems = assembleView({
        systemPromptItems: systemItems,
        layerOutputItems,
        historyItems,
        policy,
      });
    } else {
      requestItems = baseCtx.itemLog.items;
    }

    const request = allTools
      ? {
          model: step.model,
          items: requestItems,
          tools: allTools,
          params: step.params,
          outputSchema: step.output,
          emit: step.emit,
          ctx: baseCtx,
          layers,
        }
      : {
          model: step.model,
          items: requestItems,
          params: step.params,
          outputSchema: step.output,
          emit: step.emit,
          ctx: baseCtx,
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
      if (item.type === 'function_call') {
        toolCalls.push(item);
      }
    }

    // Store layers after response
    if (hasLayers) {
      await baseCtx.harness.storeLayers(layers, response, baseCtx);
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
  throw new NoeticErrorImpl({
    kind: 'step_failed',
    stepId: step.id,
    cause: new Error('Steering retries exhausted'),
    retriesExhausted: true,
  });
}

//#endregion
