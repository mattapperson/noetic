import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import { NoeticErrorImpl } from '../errors/noetic-error';
import type { LLMResponse, ModelParams, StepMeta, Tool } from '../types/common';
import type { Context } from '../types/context';
import type { FunctionCallItem, Item } from '../types/items';
import type { MemoryLayer } from '../types/memory';
import type { AgentHarness } from '../types/runtime';
import { SteeringAction } from '../types/steering';
import type { StepLLM } from '../types/step';
import { frameworkCast } from './framework-cast';
import { createMessage, extractAssistantText } from './message-helpers';
import { isMutableContext } from './typeguards';

export interface CallModelParams {
  model: string;
  items: ReadonlyArray<Item>;
  tools?: Tool[];
  params?: ModelParams;
  output?: ZodType;
  ctx: Context;
  harness?: AgentHarness;
  layers?: MemoryLayer[];
}

export type CallModelFn = (params: CallModelParams) => Promise<LLMResponse>;

const MAX_STEERING_RETRIES = 3;

export async function executeLLM<I, O>(
  step: StepLLM<I, O>,
  input: I,
  ctx: Context,
  callModel: CallModelFn,
  harness?: AgentHarness,
  layers?: MemoryLayer[],
): Promise<O> {
  // Add the input as a user message if it's a non-empty string
  if (typeof input === 'string' && input.length > 0) {
    ctx.itemLog.append(createMessage(input, 'user'));
  }

  let retries = 0;

  while (true) {
    // Call the model
    const response = await callModel({
      model: step.model,
      items: ctx.itemLog.items,
      tools: step.tools,
      params: step.params,
      output: step.output,
      ctx,
      harness,
      layers,
    });

    // Check afterModelCall steering layers
    if (layers && layers.length > 0 && harness) {
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
      // Guide with retries exhausted — proceed with last response rather than failing
    }

    // Append response items to ItemLog and extract tool calls in a single pass
    const toolCalls: FunctionCallItem[] = [];
    for (const item of response.items) {
      ctx.itemLog.append(item);
      if (item.type === 'function_call') {
        toolCalls.push(item);
      }
    }

    // Build step metadata
    const meta: StepMeta = {
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: response.usage,
      cost: response.cost,
      responseItems: response.items,
    };

    // Update mutable context fields
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

    // If output schema is provided, parse with Zod
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

    // O is string when step.output is undefined — callers without an output schema
    // receive raw text. The type system cannot express "O = string when output is omitted"
    // without conditional types that would complicate the entire Step contract.
    return frameworkCast<O>(lastText);
  }
}
