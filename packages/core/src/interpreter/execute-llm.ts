import { ZodError } from 'zod';
import { NoeticErrorImpl } from '../errors/noetic-error';
import { resolveLayerTools } from '../memory/layer-api';
import { commitLayerUsage, computeLayerUsage } from '../memory/layer-usage';
import { assembleView } from '../memory/projector';
import type { StepMeta } from '../types/common';
import type { Context } from '../types/context';
import type { FunctionCallItem, Item } from '../types/items';
import type { ContextMemory, MemoryLayer } from '../types/memory';
import type { RecallLayerOutput } from '../types/runtime';
import { SteeringAction } from '../types/steering';
import type { StepLLM } from '../types/step';
import type { Tool } from '../types/tool';
import { frameworkCast } from '../util/framework-cast';
import { createMessage, extractAssistantText } from '../util/message-helpers';
import { trackUsage } from './message-helpers';
import { isFunctionCall, isMutableContext } from './typeguards';

const MAX_STEERING_RETRIES = 3;
const emptyRecall: ReadonlyArray<RecallLayerOutput> = [];

//#region Tool Resolution

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

//#endregion

//#region Input Pipeline

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

//#endregion

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
