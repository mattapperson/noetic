import type {
  InputContentPart,
  InputFilePart,
  InputImagePart,
  InputMessageItem,
  InputTextPart,
  Item,
  LLMResponse,
  MessageItem,
  Tool,
} from '@noetic-tools/types';
import {
  frameworkCast,
  isAssistantMessage,
  isZodSchema,
  NoeticConfigError,
} from '@noetic-tools/types';
import type * as OpenRouterAgent from '@openrouter/agent';
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import { resolveWireJsonSchema } from '../runtime/tool-call';
import type { EmbedFn } from '../types/embed';
import { sanitizeToolNameForWire } from '../util/tool-name';

//#region Provider Types

type ProviderOutputItem = OpenRouterAgent.OpenResponsesResult['output'][number];
type OpenRouterInputItem =
  | OpenRouterAgent.EasyInputMessage
  | OpenRouterAgent.FunctionCallItem
  | OpenRouterAgent.FunctionCallOutputItem
  | ProviderOutputItem;
type ProviderInputContentPart = OpenRouterAgent.EasyInputMessageContentUnion1;

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

function inputTextPartToProvider(part: InputTextPart): OpenRouterAgent.InputText {
  return {
    type: 'input_text',
    text: part.text,
  };
}

function inputImagePartToProvider(
  part: InputImagePart,
): OpenRouterAgent.EasyInputMessageContentInputImage {
  return {
    type: 'input_image',
    imageUrl: part.imageUrl,
    detail: part.detail ?? 'auto',
  };
}

function inputFilePartToProvider(part: InputFilePart): OpenRouterAgent.InputFile {
  return {
    type: 'input_file',
    filename: part.filename,
    fileData: part.fileData,
    fileUrl: part.fileUrl,
    fileId: part.fileId,
  };
}

function inputContentPartToProvider(part: InputContentPart): ProviderInputContentPart {
  if (part.type === 'input_text') {
    return inputTextPartToProvider(part);
  }
  if (part.type === 'input_image') {
    return inputImagePartToProvider(part);
  }
  return inputFilePartToProvider(part);
}

function contentPartsToProviderContent(
  parts: ReadonlyArray<{
    type: string;
    text?: string;
  }>,
): string | ProviderInputContentPart[] {
  const hasStructuredInput = parts.some(
    (part) => part.type === 'input_image' || part.type === 'input_file',
  );
  if (!hasStructuredInput) {
    return contentPartsToText(parts);
  }
  return frameworkCast<ReadonlyArray<InputContentPart>>(parts).map(inputContentPartToProvider);
}

/** @internal A tool result as the provider takes it: text, or content parts. */
export function toolOutputToProvider(
  output: string | ReadonlyArray<InputContentPart>,
): OpenRouterAgent.FunctionCallOutputItem['output'] {
  if (typeof output === 'string') {
    return output;
  }
  return output.map((part) => {
    if (part.type === 'input_text') {
      return inputTextPartToProvider(part);
    }
    return part.type === 'input_image'
      ? inputImagePartToProvider(part)
      : inputFilePartToProvider(part);
  });
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

/** Framework-owned extension items (`noetic:*`, e.g. a trigger's `noetic:connection_event`) are never sent to a provider. */
const FRAMEWORK_ITEM_PREFIX = 'noetic:';

function itemToInputItem(item: Item): OpenRouterInputItem | null {
  if (typeof item.type === 'string' && item.type.startsWith(FRAMEWORK_ITEM_PREFIX)) {
    return null;
  }
  if (item.type === 'message' && 'content' in item && 'role' in item) {
    // All message types (input and output) are converted to EasyInputMessage
    // because the SDK's input union does not accept ResponsesOutputMessage directly.
    return {
      role: item.role,
      content: contentPartsToProviderContent(item.content),
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

/**
 * @internal
 *
 * A missing `cachedTokens` stays `undefined` rather than collapsing to `0`:
 * context anchoring reads it to decide whether the prompt prefix survived, and
 * "this provider reports no cache figures" must not look like "nothing was
 * cached".
 */
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
    cacheWriteTokens: cacheWriteTokensOf(usage.inputTokensDetails),
  };
}

/**
 * OpenRouter reports `cache_write_tokens` alongside `cached_tokens`, but the
 * SDK's `InputTokensDetails` type declares only the latter. Read it off the
 * value rather than the type, and stay `undefined` when it is genuinely absent
 * — a write of zero and no report at all mean different things to the epoch
 * logic (see `noteCacheOutcome`).
 */
function cacheWriteTokensOf(details: unknown): number | undefined {
  if (typeof details !== 'object' || details === null || !('cacheWriteTokens' in details)) {
    return undefined;
  }
  const value = details.cacheWriteTokens;
  return typeof value === 'number' ? value : undefined;
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
/**
 * The OpenRouter SDK requires a live Zod `inputSchema` and runs
 * `z.toJSONSchema` over it; it never executes these tool objects (Noetic owns
 * its tool loop). For non-Zod inputs, bridge the resolved JSON Schema through
 * a wire-only `z.any().meta(...)` so the SDK emits it unchanged. Noetic, not
 * the SDK, validates tool-call args.
 */
function inputSchemaForWire(tool: Tool): ZodTypeAny {
  if (isZodSchema(tool.input)) {
    return tool.input;
  }
  return z.any().meta(
    resolveWireJsonSchema({
      schema: tool.input,
      explicitJsonSchema: tool.inputJsonSchema,
      what: `input schema of tool '${tool.name}'`,
    }),
  );
}

/** @internal */
export function convertTools({ tools }: ConvertToolsParams): SdkTool[] {
  return tools.map((t) =>
    frameworkCast<SdkTool>({
      type: 'function',
      function: {
        name: sanitizeToolNameForWire(t.name),
        description: t.description,
        inputSchema: inputSchemaForWire(t),
      },
    }),
  );
}

/**
 * @internal
 * Tools as the wire carries them, for sizing a request. The agent turns each live
 * Zod input schema into JSON Schema only when it sends, so serializing `convertTools`
 * output would drop every description and constraint the provider bills for.
 */
export function toolsOnWire(tools: ReadonlyArray<SdkTool>): unknown[] {
  return tools.map((tool) => {
    if (!('function' in tool) || !isZodSchema(tool.function.inputSchema)) {
      return tool;
    }
    return {
      ...tool,
      function: {
        ...tool.function,
        inputSchema: z.toJSONSchema(tool.function.inputSchema, {
          target: 'draft-07',
          unrepresentable: 'any',
        }),
      },
    };
  });
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
 * @throws `NoeticConfigError` with code `MISSING_API_KEY` if `apiKey` is empty or omitted.
 */
export function createOpenRouterEmbed(apiKey?: string, embeddingModel?: string): EmbedFn {
  if (!apiKey) {
    throw new NoeticConfigError({
      code: 'MISSING_API_KEY',
      message: 'createOpenRouterEmbed() requires an OpenRouter API key.',
      hint: 'Pass the key explicitly, e.g. createOpenRouterEmbed(process.env.OPENROUTER_API_KEY).',
    });
  }
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
