import type { CallModelInput } from '@openrouter/sdk';
import type {
  OpenResponsesEasyInputMessage,
  OpenResponsesFunctionCallOutput,
  OpenResponsesFunctionToolCall,
  OpenResponsesNonStreamingResponse,
  OpenResponsesUsage,
  ResponsesOutputItem,
  ResponsesOutputItemFunctionCall,
  ResponsesOutputMessage,
} from '@openrouter/sdk/models';
import { z } from 'zod';

import { frameworkCast } from '../interpreter/framework-cast';
import { isAssistantMessage, isOutputText } from '../interpreter/typeguards';
import { buildToolExecutionContext } from '../runtime/tool-memory';
import type { LLMResponse, Tool } from '../types/common';
import type { Context } from '../types/context';
import type { EmbedFn } from '../types/embed';
import type { ContentPart, FunctionCallItem, Item, MessageItem } from '../types/items';
import type { MemoryLayer } from '../types/memory';
import type { AgentHarnessContract } from '../types/runtime';
import { SteeringAction } from '../types/steering';

//#region SDK Tool Type

// Re-export the SDK Tool type under a distinct name to avoid collision with
// Noetic's Tool type. Import aliases (`as`) are banned by our biome config,
// so we use a type extracted from CallModelInput's generic parameter instead.
type SdkToolArray = CallModelInput extends {
  tools?: infer T;
}
  ? NonNullable<T>
  : never;
/** @internal */
export type SdkTool = SdkToolArray[number];

//#endregion

//#region Type Guards

function isOutputMessage(entry: ResponsesOutputItem): entry is ResponsesOutputMessage & {
  type: 'message';
} {
  return entry.type === 'message';
}

function isOutputFunctionCall(
  entry: ResponsesOutputItem,
): entry is ResponsesOutputItemFunctionCall & {
  type: 'function_call';
} {
  return entry.type === 'function_call';
}

//#endregion

//#region Types

type OpenRouterInputItem =
  | OpenResponsesEasyInputMessage
  | OpenResponsesFunctionToolCall
  | OpenResponsesFunctionCallOutput;

/** @internal */
export interface ConvertToolsParams {
  tools: ReadonlyArray<Tool>;
}

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

/** @internal */
export function extractSystemInstruction(items: ReadonlyArray<Item>): {
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
      callId: item.callId,
      id: item.id,
      name: item.name,
      arguments: item.arguments,
    } satisfies OpenResponsesFunctionToolCall;
  }

  if (item.type === 'function_call_output') {
    return {
      type: 'function_call_output',
      callId: item.callId,
      output: item.output,
    } satisfies OpenResponsesFunctionCallOutput;
  }

  // Skip reasoning and extension items — internal metadata
  return null;
}

/** @internal */
export function itemsToInput(items: ReadonlyArray<Item>): OpenRouterInputItem[] {
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
  if (isOutputMessage(entry)) {
    const text = contentPartToText(entry.content);

    if (!text) {
      return null;
    }

    return {
      id: entry.id,
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

  if (isOutputFunctionCall(entry)) {
    return {
      id: entry.id ?? crypto.randomUUID(),
      status: 'completed',
      type: 'function_call',
      callId: entry.callId,
      name: entry.name,
      arguments: entry.arguments,
    } satisfies FunctionCallItem;
  }

  // Skip web_search_call, file_search_call, image_generation_call, reasoning
  return null;
}

/** @internal */
export function responseToNoeticItems(response: OpenResponsesNonStreamingResponse): Item[] {
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

/** @internal */
export function extractUsage(usage: OpenResponsesUsage | null | undefined): LLMResponse['usage'] {
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

// We construct the SDK tool shape manually and use frameworkCast to bridge
// the internal Zod type gap between Noetic's Tool interface and the OpenRouter SDK.
// This is safe because callModel only uses inputSchema for JSON Schema
// generation and validation.
//
// IMPORTANT: We intentionally omit `execute` from the SDK tool definitions.
// This prevents the SDK from handling tool calls internally, which would
// make tool interactions invisible to Noetic's itemLog, token tracking,
// and observability. Instead, the AgentHarness manages the tool loop.
/** @internal */
export function convertTools({ tools }: ConvertToolsParams): SdkTool[] {
  return tools.map((t) =>
    frameworkCast<SdkTool>({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        inputSchema: t.input,
      },
    }),
  );
}

/** @internal */
export interface ExecuteToolCallParams {
  toolName: string;
  args: unknown;
  tools: ReadonlyArray<Tool>;
  context: Context;
  harness: AgentHarnessContract;
  layers?: MemoryLayer[];
}

/** @internal Execute a single tool call with steering checks. */
export async function executeToolCall(params: ExecuteToolCallParams): Promise<string> {
  const matchedTool = params.tools.find((t) => t.name === params.toolName);
  if (!matchedTool) {
    return `Error: unknown tool '${params.toolName}'`;
  }

  if (params.layers && params.layers.length > 0) {
    const decision = await params.harness.beforeToolCall(
      params.layers,
      params.toolName,
      params.args,
      params.context,
    );
    if (decision.action === SteeringAction.Deny) {
      return `Tool call denied: ${decision.guidance ?? 'steering rule violation'}`;
    }
    if (decision.action === SteeringAction.Guide) {
      return `Tool call redirected: ${decision.guidance}`;
    }
  }

  const toolCtx = buildToolExecutionContext(params.context, params.harness);
  try {
    const result = await matchedTool.execute(params.args, toolCtx);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

//#endregion

//#region Public API

/**
 * Creates an `EmbedFn` that calls the OpenRouter embeddings API.
 *
 * @public
 * @param apiKey - OpenRouter API key.
 * @param embeddingModel - Model identifier (default: `'openai/text-embedding-3-small'`).
 * @returns An `EmbedFn` that produces embedding vectors for the given texts.
 */
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
