import type { StepLLM } from '../types/step';
import type { Context } from '../types/context';
import type { LLMResponse, StepMeta, Tool, ModelParams } from '../types/common';
import type { Item, MessageItem, FunctionCallItem } from '../types/items';
import { OrchidErrorImpl } from '../errors/orchid-error';
import { isMutableContext, isAssistantMessage, isOutputText } from './typeguards';
import { ZodError, type ZodType } from 'zod';

export type CallModelFn = (
  model: string,
  items: ReadonlyArray<Item>,
  tools?: Tool[],
  params?: ModelParams,
  output?: ZodType,
) => Promise<LLMResponse>;

function createUserMessage(text: string): MessageItem {
  return {
    id: crypto.randomUUID(),
    status: 'completed',
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

function extractAssistantText(items: Item[]): string {
  const lastTextItem = [...items]
    .reverse()
    .find(isAssistantMessage);

  if (!lastTextItem) return '';

  return lastTextItem.content
    ?.filter(isOutputText)
    ?.map((c) => c.text)
    ?.join('') ?? '';
}

export async function executeLLM<I, O>(
  step: StepLLM<I, O>,
  input: I,
  ctx: Context,
  callModel: CallModelFn,
): Promise<O> {
  // Add the input as a user message if it's a non-empty string
  if (typeof input === 'string' && input.length > 0) {
    ctx.itemLog.append(createUserMessage(input));
  }

  // Call the model
  const response = await callModel(
    step.model,
    ctx.itemLog.items,
    step.tools,
    step.params,
    step.output,
  );

  // Append response items to ItemLog
  for (const item of response.items) {
    ctx.itemLog.append(item);
  }

  // Extract tool calls from response
  const toolCalls = response.items.filter(
    (i): i is FunctionCallItem => i.type === 'function_call',
  );

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
        throw new OrchidErrorImpl({
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

  // SAFETY: O is string when step.output is undefined — callers without an output schema
  // receive raw text. The type system cannot express "O = string when output is omitted"
  // without conditional types that would complicate the entire Step contract.
  return lastText as unknown as O;
}
