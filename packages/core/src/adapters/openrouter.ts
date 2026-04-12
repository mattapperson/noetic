import type * as OpenRouterAgent from '@openrouter/agent';
import { z } from 'zod';

import { frameworkCast } from '../interpreter/framework-cast';
import { isAssistantMessage } from '../interpreter/typeguards';
import { buildToolExecutionContext } from '../runtime/tool-memory';
import type { LLMResponse, Tool } from '../types/common';
import type { Context } from '../types/context';
import type { EmbedFn } from '../types/embed';
import type { InputMessageItem, Item, MessageItem } from '../types/items';
import type { MemoryLayer } from '../types/memory';
import type { AgentHarnessContract } from '../types/runtime';
import { SteeringAction } from '../types/steering';

//#region Provider Types

type ProviderOutputItem = OpenRouterAgent.OpenResponsesResult['output'][number];
type OpenRouterInputItem =
  | OpenRouterAgent.EasyInputMessage
  | OpenRouterAgent.FunctionCallItem
  | OpenRouterAgent.FunctionCallOutputItem
  | ProviderOutputItem;

/** @internal */
export type SdkTool = OpenRouterAgent.Tool;

//#endregion

//#region Types

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

function isTextPart(p: { type: string }): p is {
  type: string;
  text: string;
} {
  return p.type === 'output_text' || p.type === 'input_text';
}

function contentPartsToText(
  parts: ReadonlyArray<{
    type: string;
    text?: string;
  }>,
): string {
  return parts
    .filter(isTextPart)
    .map((p) => p.text)
    .join('');
}

//#endregion

//#region Item → OpenRouter Input Conversion

/** @internal Extracts system messages from items and returns them as a single instructions string. */
export function extractSystemInstruction(items: ReadonlyArray<Item>): {
  instructions: string | undefined;
  remaining: Item[];
} {
  const systemTexts: string[] = [];
  const remaining: Item[] = [];

  for (const item of items) {
    if (item.type === 'message' && 'role' in item && item.role === 'system') {
      const msgItem = item satisfies InputMessageItem;
      systemTexts.push(contentPartsToText(msgItem.content));
      continue;
    }
    remaining.push(item);
  }

  if (systemTexts.length === 0) {
    return {
      instructions: undefined,
      remaining,
    };
  }

  return {
    instructions: systemTexts.join('\n\n'),
    remaining,
  };
}

function itemToInputItem(item: Item): OpenRouterInputItem | null {
  if (item.type === 'message' && 'content' in item && 'role' in item) {
    // All message types (input and output) are converted to EasyInputMessage
    // because the SDK's input union does not accept ResponsesOutputMessage directly.
    return {
      role: item.role,
      content: contentPartsToText(item.content),
    } satisfies OpenRouterAgent.EasyInputMessage;
  }

  if (item.type === 'function_call') {
    return {
      type: 'function_call',
      callId: item.callId,
      id: item.id ?? crypto.randomUUID(),
      name: item.name,
      arguments: item.arguments,
    } satisfies OpenRouterAgent.FunctionCallItem;
  }

  if (item.type === 'function_call_output') {
    return {
      type: 'function_call_output',
      callId: item.callId,
      output: item.output,
    } satisfies OpenRouterAgent.FunctionCallOutputItem;
  }

  // Reasoning, web_search_call, file_search_call, image_generation_call,
  // server tool outputs — pass through directly for round-tripping
  return frameworkCast<ProviderOutputItem>(item);
}

/** @internal Converts Noetic Items to OpenRouter SDK input format. */
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

//#region OpenRouter Response → Noetic Item Passthrough

/**
 * @internal Extracts output items from an SDK response, passing them through directly
 * as Open Responses compliant items. Falls back to creating a message from `outputText`
 * when the output array contains no message items.
 */
export function extractOutputItems(response: OpenRouterAgent.OpenResponsesResult): Item[] {
  const items: Item[] = frameworkCast<Item[]>(response.output);

  const hasMessage = items.some(isAssistantMessage);
  if (hasMessage || !response.outputText) {
    return items;
  }

  // Fallback: no message items but outputText exists
  return [
    frameworkCast<MessageItem>({
      id: crypto.randomUUID(),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: response.outputText,
        },
      ],
    }),
    ...items,
  ];
}

/** @internal */
export function extractUsage(
  usage: OpenRouterAgent.Usage | null | undefined,
): LLMResponse['usage'] {
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
