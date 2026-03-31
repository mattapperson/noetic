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
import { isMutableContext } from './typeguards';

const MAX_STEERING_RETRIES = 3;

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
  let retries = 0;

  while (retries <= MAX_STEERING_RETRIES) {
    const request = allTools
      ? {
          model: step.model,
          items: baseCtx.itemLog.items,
          tools: allTools,
          params: step.params,
          outputSchema: step.output,
          emit: step.emit,
          ctx: baseCtx,
          layers,
        }
      : {
          model: step.model,
          items: baseCtx.itemLog.items,
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
      if (item.type === 'function_call') {
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
