import { ZodError } from 'zod';
import { NoeticErrorImpl } from '../errors/noetic-error';
import { resolveLayerTools } from '../memory/layer-api';
import type { StepMeta, Tool } from '../types/common';
import type { Context } from '../types/context';
import type { FunctionCallItem } from '../types/items';
import type { ContextMemory, MemoryLayer } from '../types/memory';
import { SteeringAction } from '../types/steering';
import type { StepLLM } from '../types/step';
import { frameworkCast } from './framework-cast';
import { createMessage, extractAssistantText, trackUsage } from './message-helpers';
import { isFunctionCall, isMutableContext } from './typeguards';

const MAX_STEERING_RETRIES = 3;

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

export async function executeLLM<TMemory, I, O>(
  step: StepLLM<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  layers?: MemoryLayer[],
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextMemory>>(ctx);

  // Process user input through onItemAppend pipeline
  if (typeof input === 'string' && input.length > 0) {
    const userItem = createMessage(input, 'user');

    if (layers && layers.length > 0) {
      // Run through pipeline — layers can filter/transform
      const { items: finalItems, rerenderRequests } = await baseCtx.harness.runAppendPipeline(
        layers,
        [
          userItem,
        ],
        baseCtx,
      );

      // Append only the items that survived the pipeline
      for (const item of finalItems) {
        baseCtx.itemLog.append(item);
      }

      // Process immediate re-render requests with the user query for context-aware recall
      const immediateRequests = rerenderRequests.filter((r) => r.timing === 'immediate');
      if (immediateRequests.length > 0) {
        const userQuery = typeof input === 'string' ? input : '';
        await baseCtx.harness.executeRerender(
          immediateRequests,
          layers,
          baseCtx,
          new Map(),
          userQuery,
        );
      }
    } else {
      // No layers, append directly
      baseCtx.itemLog.append(userItem);
    }
  }

  const { tools: resolvedTools, allowedToolNames } = resolveToolsAndRestrictions(
    step,
    layers,
    baseCtx,
  );
  let retries = 0;

  while (retries <= MAX_STEERING_RETRIES) {
    const request = resolvedTools
      ? {
          model: step.model,
          items: baseCtx.itemLog.items,
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
          items: baseCtx.itemLog.items,
          instructions: step.instructions,
          params: step.params,
          outputSchema: step.output,
          emit: step.emit,
        };
    const response = await baseCtx.harness.callModel(request);

    if (layers && layers.length > 0) {
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
