import type { OpenRouter, Tool as SdkTool, TurnContext } from '@openrouter/sdk';
import type {
  OpenResponsesEasyInputMessage,
  OpenResponsesFunctionCallOutput,
  OpenResponsesFunctionToolCall,
  OpenResponsesInput,
  OpenResponsesNonStreamingResponse,
  OpenResponsesUsage,
  ResponsesOutputItem,
  ResponsesOutputItemFunctionCall,
  ResponsesOutputMessage,
} from '@openrouter/sdk/models';
import { z } from 'zod';

import type { CallModelFn, CallModelParams } from '../interpreter/execute-llm';
import { isAssistantMessage, isOutputText } from '../interpreter/typeguards';
import { buildToolExecutionContext } from '../runtime/tool-memory';
import type { LLMResponse, Tool } from '../types/common';
import type { Context } from '../types/context';
import type { EmbedFn } from '../types/embed';
import type { ContentPart, FunctionCallItem, Item, MessageItem } from '../types/items';
import type { Runtime } from '../types/runtime';

//#region Types

type OpenRouterInputItem =
  | OpenResponsesEasyInputMessage
  | OpenResponsesFunctionToolCall
  | OpenResponsesFunctionCallOutput;

const EmbeddingsResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number(),
    }),
  ),
});

//#endregion

//#region Helpers

function isInputText(p: ContentPart): p is Extract<
  ContentPart,
  {
    type: 'input_text';
  }
> {
  return p.type === 'input_text';
}

function contentPartToText(parts: ReadonlyArray<ContentPart>): string {
  return parts
    .filter(
      (
        p,
      ): p is Extract<
        ContentPart,
        {
          type: 'output_text' | 'input_text';
        }
      > => isOutputText(p) || isInputText(p),
    )
    .map((p) => p.text)
    .join('');
}

//#endregion

//#region Item → OpenRouter Input Conversion

function extractSystemInstruction(items: ReadonlyArray<Item>): {
  instructions: string | undefined;
  remaining: Item[];
} {
  const systemItems: MessageItem[] = [];
  const remaining: Item[] = [];

  for (const item of items) {
    if (item.type === 'message' && item.role === 'system') {
      systemItems.push(item);
      continue;
    }
    remaining.push(item);
  }

  if (systemItems.length === 0) {
    return {
      instructions: undefined,
      remaining,
    };
  }

  const instructions = systemItems.map((s) => contentPartToText(s.content)).join('\n\n');
  return {
    instructions,
    remaining,
  };
}

function itemToInputItem(item: Item): OpenRouterInputItem | null {
  if (item.type === 'message') {
    return {
      role: item.role,
      content: contentPartToText(item.content),
    } satisfies OpenResponsesEasyInputMessage;
  }

  if (item.type === 'function_call') {
    return {
      type: 'function_call',
      callId: item.call_id,
      id: item.id,
      name: item.name,
      arguments: item.arguments,
    } satisfies OpenResponsesFunctionToolCall;
  }

  if (item.type === 'function_call_output') {
    return {
      type: 'function_call_output',
      callId: item.call_id,
      output: item.output,
    } satisfies OpenResponsesFunctionCallOutput;
  }

  // Skip reasoning and extension items — internal metadata
  return null;
}

function itemsToInput(items: ReadonlyArray<Item>): OpenResponsesInput {
  const result: OpenRouterInputItem[] = [];
  for (const item of items) {
    const inputItem = itemToInputItem(item);
    if (!inputItem) {
      continue;
    }
    result.push(inputItem);
  }
  return result;
}

//#endregion

//#region OpenRouter Response → Noetic Item Conversion

function outputItemToNoeticItem(entry: ResponsesOutputItem): Item | null {
  if (entry.type === 'message') {
    // SAFETY: TypeScript narrows entry.type to 'message' but the SDK union type
    // does not automatically narrow the full intersection. The cast is safe after
    // the discriminant check above.
    const msg = entry as ResponsesOutputMessage & {
      type: 'message';
    };
    const text = contentPartToText(msg.content);

    if (!text) {
      return null;
    }

    return {
      id: msg.id,
      status: 'completed',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text,
        },
      ],
    } satisfies MessageItem;
  }

  if (entry.type === 'function_call') {
    // SAFETY: Same discriminant narrowing as above for the function_call variant.
    const fc = entry as ResponsesOutputItemFunctionCall & {
      type: 'function_call';
    };
    return {
      id: fc.id ?? crypto.randomUUID(),
      status: 'completed',
      type: 'function_call',
      call_id: fc.callId,
      name: fc.name,
      arguments: fc.arguments,
    } satisfies FunctionCallItem;
  }

  // Skip web_search_call, file_search_call, image_generation_call, reasoning
  return null;
}

function responseToNoeticItems(response: OpenResponsesNonStreamingResponse): Item[] {
  const items: Item[] = [];
  let hasMessage = false;

  for (const entry of response.output) {
    const item = outputItemToNoeticItem(entry);
    if (!item) {
      continue;
    }
    if (!hasMessage && isAssistantMessage(item)) {
      hasMessage = true;
    }
    items.push(item);
  }

  // If no message items but outputText exists, create an assistant message
  if (!hasMessage && response.outputText) {
    items.unshift({
      id: crypto.randomUUID(),
      status: 'completed',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: response.outputText,
        },
      ],
    } satisfies MessageItem);
  }

  return items;
}

function extractUsage(usage: OpenResponsesUsage | null | undefined): LLMResponse['usage'] {
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
    };
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.inputTokensDetails?.cachedTokens,
  };
}

//#endregion

//#region Tool Conversion

// SAFETY: Noetic uses Zod v3 while the OpenRouter SDK expects Zod v4 ($ZodObject).
// The runtime shapes are compatible — both produce JSON Schema from .describe()/.shape.
// We construct the SDK tool shape manually and cast through unknown to bridge the
// Zod version gap. This is safe because callModel only uses inputSchema for JSON Schema
// generation and validation, which works identically across Zod 3 and 4.
function convertTools(tools: ReadonlyArray<Tool>, ctx: Context, runtime?: Runtime): SdkTool[] {
  return tools.map(
    (t) =>
      ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          inputSchema: t.input,
          execute: async (args: unknown, turnContext?: TurnContext) => {
            const toolCtx = buildToolExecutionContext(ctx, runtime, turnContext);
            return t.execute(args, toolCtx);
          },
        },
      }) as unknown as SdkTool,
  );
}

//#endregion

//#region Public API

export function createOpenRouterCallModel(client: OpenRouter): CallModelFn {
  return async (params: CallModelParams): Promise<LLMResponse> => {
    const { instructions, remaining } = extractSystemInstruction(params.items);
    const input = itemsToInput(remaining);

    const tools =
      params.tools && params.tools.length > 0
        ? convertTools(params.tools, params.ctx, params.runtime)
        : undefined;

    const result = client.callModel({
      model: params.model,
      input,
      instructions,
      tools,
      temperature: params.params?.temperature,
      maxOutputTokens: params.params?.maxTokens,
      topP: params.params?.topP,
    });

    const response = await result.getResponse();
    const noeticItems = responseToNoeticItems(response);

    return {
      items: noeticItems,
      usage: extractUsage(response.usage),
      cost: response.usage?.cost ?? undefined,
    };
  };
}

export function createOpenRouterEmbed(apiKey: string, embeddingModel?: string): EmbedFn {
  const model = embeddingModel ?? 'openai/text-embedding-3-small';

  return async (texts: readonly string[]): Promise<readonly number[][]> => {
    const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: texts,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenRouter embeddings request failed: ${response.status} ${response.statusText}`,
      );
    }

    const json = EmbeddingsResponseSchema.parse(await response.json());

    // Sort by index to preserve input order
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  };
}

//#endregion
