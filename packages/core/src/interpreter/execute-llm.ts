import { ZodError } from 'zod';
import { NoeticErrorImpl } from '../errors/noetic-error';
import type { StepMeta } from '../types/common';
import type { Context } from '../types/context';
import type { FunctionCallItem } from '../types/items';
import type { MemoryLayer } from '../types/memory';
import { SteeringAction } from '../types/steering';
import type { StepLLM } from '../types/step';
import { frameworkCast } from './framework-cast';
import { createMessage, extractAssistantText } from './message-helpers';
import { isMutableContext } from './typeguards';

const MAX_STEERING_RETRIES = 3;

export async function executeLLM<I, O>(
  step: StepLLM<I, O>,
  input: I,
  ctx: Context,
  layers?: MemoryLayer[],
): Promise<O> {
  if (typeof input === 'string' && input.length > 0) {
    ctx.itemLog.append(createMessage(input, 'user'));
  }

  const harness = ctx.harness;
  let retries = 0;

  while (retries <= MAX_STEERING_RETRIES) {
    const request = step.tools
      ? {
          model: step.model,
          items: ctx.itemLog.items,
          tools: step.tools,
          params: step.params,
          ctx,
          layers,
        }
      : {
          model: step.model,
          items: ctx.itemLog.items,
          params: step.params,
        };
    const response = await harness.callModel(request);

    if (layers && layers.length > 0) {
      const decision = await harness.afterModelCall(layers, response, ctx);

      if (decision.action === SteeringAction.Deny) {
        throw new NoeticErrorImpl({
          kind: 'steering_denied',
          guidance: decision.guidance,
        });
      }

      if (decision.action === SteeringAction.Guide && retries < MAX_STEERING_RETRIES) {
        ctx.itemLog.append(
          createMessage(decision.guidance ?? 'Please adjust your response.', 'developer'),
        );
        retries++;
        continue;
      }
    }

    const toolCalls: FunctionCallItem[] = [];
    for (const item of response.items) {
      ctx.itemLog.append(item);
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

    if (isMutableContext(ctx)) {
      ctx.lastStepMeta = meta;
      ctx.tokens.input += response.usage.inputTokens;
      ctx.tokens.output += response.usage.outputTokens;
      ctx.tokens.total += response.usage.inputTokens + response.usage.outputTokens;
      if (response.cost) {
        ctx.cost = ctx.cost + response.cost;
      }
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

  // Retries exhausted — should not reach here in normal flow
  throw new NoeticErrorImpl({
    kind: 'step_failed',
    stepId: step.id,
    cause: new Error('Steering retries exhausted'),
    retriesExhausted: true,
  });
}
