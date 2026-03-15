import type { StepLLM } from '../types/step';
import type { Context } from '../types/context';
import type { LLMResponse, StepMeta } from '../types/common';
import type { Item, MessageItem, FunctionCallItem } from '../types/items';
import { OrchidErrorImpl } from '../errors/orchid-error';
import { ZodError } from 'zod';

export type CallModelFn = (
  model: string,
  items: ReadonlyArray<Item>,
  tools?: any[],
  params?: any,
  output?: any,
) => Promise<LLMResponse>;

export async function executeLLM<I, O>(
  step: StepLLM<I, O>,
  input: I,
  ctx: Context,
  callModel: CallModelFn,
): Promise<O> {
  // Add the input as a user message if it's a non-empty string
  if (typeof input === 'string' && input.length > 0) {
    ctx.itemLog.append({
      id: crypto.randomUUID(),
      status: 'completed',
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: input }],
    } as MessageItem);
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

  // Set lastStepMeta (cast to mutable since Context interface has readonly)
  (ctx as any).lastStepMeta = meta;

  // Accumulate token usage
  (ctx as any).tokens = {
    input: ctx.tokens.input + response.usage.inputTokens,
    output: ctx.tokens.output + response.usage.outputTokens,
    total: ctx.tokens.total + response.usage.inputTokens + response.usage.outputTokens,
  };

  // Accumulate cost
  if (response.cost) {
    (ctx as any).cost = ctx.cost + response.cost;
  }

  // Find the last assistant message to extract text output
  const lastTextItem = [...response.items]
    .reverse()
    .find((i): i is MessageItem => i.type === 'message' && (i as MessageItem).role === 'assistant');

  const lastText = lastTextItem?.content
    ?.filter((c) => c.type === 'output_text')
    ?.map((c) => (c as Extract<typeof c, { type: 'output_text' }>).text)
    ?.join('') ?? '';

  // If output schema is provided, parse with Zod
  if (step.output) {
    try {
      const parsed = JSON.parse(lastText);
      const result = step.output.parse(parsed);
      return result as O;
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

  // Return raw text as output
  return lastText as unknown as O;
}
