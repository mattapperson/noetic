import type { ContextLayer } from '@noetic-tools/context';
import type {
  AgentHarnessContract,
  Context,
  InputContentPart,
  InputFilePart,
  InputImagePart,
  InputMessageItem,
  InputTextPart,
  Item,
  LLMResponse,
  MessageItem,
  StandardSchemaV1,
  Tool,
} from '@noetic-tools/types';
import {
  frameworkCast,
  isAssistantMessage,
  isStandardJsonSchema,
  isZodSchema,
  NoeticConfigError,
  SteeringAction,
  validateSchema,
} from '@noetic-tools/types';
import type * as OpenRouterAgent from '@openrouter/agent';
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import { buildToolExecutionContext } from '../runtime/tool-context';
import { emitToolUi } from '../runtime/tool-ui';
import type { EmbedFn } from '../types/embed';

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
 * Provider APIs (Anthropic via OpenRouter) enforce tool names match
 * `^[a-zA-Z0-9_-]{1,64}$`. Noetic's internal layer-tool names use `layerId/fn`
 * which contains a forbidden `/`. We translate to a wire-safe form only at
 * the SDK boundary; internal tool-name identity (and every codebase reference
 * to names like `plan/updatePrd`) is preserved.
 */
export function sanitizeToolNameForWire(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Resolve the JSON Schema sent to the model. Zod keeps its legacy-compatible
 * fast path. For other validators, an explicit override wins over the Standard
 * JSON Schema v1 companion trait.
 * @internal
 */
export function resolveWireJsonSchema(params: {
  schema: StandardSchemaV1;
  explicitJsonSchema?: Record<string, unknown>;
  what: string;
}): Record<string, unknown> {
  const { schema, explicitJsonSchema, what } = params;
  if (isZodSchema(schema)) {
    return sanitizeJsonSchema(
      z.toJSONSchema(schema, {
        target: 'draft-07',
      }),
    );
  }
  if (explicitJsonSchema) {
    return sanitizeJsonSchema(explicitJsonSchema);
  }
  if (isStandardJsonSchema(schema)) {
    try {
      return sanitizeJsonSchema(
        schema['~standard'].jsonSchema.input({
          target: 'draft-07',
        }),
      );
    } catch {
      // Fall through to the actionable configuration error below.
    }
  }
  throw new NoeticConfigError({
    code: 'MISSING_JSON_SCHEMA',
    message: `The ${what} cannot be converted to JSON Schema.`,
    hint: 'Use a schema implementing StandardJSONSchemaV1 or pass `inputJsonSchema` on tool() / `outputJsonSchema` on step.llm().',
  });
}

function sanitizeJsonSchema(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith('~'))
      .map(([key, nested]) => [
        key,
        sanitizeJsonSchemaValue(nested),
      ]),
  );
}

function sanitizeJsonSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonSchemaValue);
  }
  if (typeof value === 'object' && value !== null) {
    return sanitizeJsonSchema(frameworkCast<Record<string, unknown>>(value));
  }
  return value;
}

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

/** @internal */
export interface ExecuteToolCallParams {
  toolName: string;
  args: unknown;
  tools: ReadonlyArray<Tool>;
  context: Context;
  harness: AgentHarnessContract;
  layers?: ContextLayer[];
  /** The model's `function_call` id — keys this call's tool-UI region. */
  callId?: string;
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return Symbol.asyncIterator in value;
}

/** @internal Execute a single tool call with steering checks. */
export async function executeToolCall(params: ExecuteToolCallParams): Promise<{
  output: string;
  result?: unknown;
  error?: boolean;
}> {
  // Model sees sanitised tool names (see `sanitizeToolNameForWire`). Match
  // against both the original and sanitised name so internal identity (e.g.
  // `plan/updatePrd` used by steering whitelists, skill docs, and the
  // `plan()` layer's `beforeToolCall` hook) stays intact while the wire name is
  // provider-compliant.
  const matchedTool = params.tools.find(
    (t) => t.name === params.toolName || sanitizeToolNameForWire(t.name) === params.toolName,
  );
  if (!matchedTool) {
    return {
      output: `Error: unknown tool '${params.toolName}'`,
      error: true,
    };
  }

  if (params.layers && params.layers.length > 0) {
    const decision = await params.harness.beforeToolCall(
      params.layers,
      params.toolName,
      params.args,
      params.context,
    );
    if (decision.action === SteeringAction.Deny) {
      return {
        output: `Tool call denied: ${decision.guidance ?? 'steering rule violation'}`,
        error: true,
      };
    }
    if (decision.action === SteeringAction.Guide) {
      return {
        output: `Tool call redirected: ${decision.guidance}`,
        error: true,
      };
    }
  }

  const validated = await validateSchema(matchedTool.input, params.args);
  if (!validated.success) {
    return {
      output: `Error: invalid arguments for tool '${params.toolName}': ${validated.zodError.message}`,
      error: true,
    };
  }
  const parsedArgs = validated.value;

  const toolCtx = buildToolExecutionContext(params.context, params.harness);
  const callId = params.callId;
  const uiBase =
    callId !== undefined
      ? {
          ctx: params.context,
          tool: matchedTool,
          callId,
          args: parsedArgs,
        }
      : undefined;
  if (uiBase) {
    emitToolUi({
      ...uiBase,
      phase: 'call',
    });
  }
  try {
    const executionResult = matchedTool.execute(parsedArgs, toolCtx);
    // Generator tools stream progress; drive them here so tool-UI `progress`
    // fragments emit per yield (the non-UI case just consumes to the return).
    let result: unknown;
    if (isAsyncGenerator(executionResult)) {
      for (;;) {
        const next = await executionResult.next();
        if (next.done) {
          result = next.value;
          break;
        }
        if (uiBase) {
          emitToolUi({
            ...uiBase,
            phase: 'progress',
            events: [
              next.value,
            ],
          });
        }
      }
    } else {
      result = await executionResult;
    }
    if (uiBase) {
      emitToolUi({
        ...uiBase,
        phase: 'result',
        output: result,
      });
    }
    return {
      output: typeof result === 'string' ? result : JSON.stringify(result),
      result,
    };
  } catch (e) {
    if (uiBase) {
      emitToolUi({
        ...uiBase,
        phase: 'error',
        error: e,
      });
    }
    return {
      output: `Error: ${e instanceof Error ? e.message : String(e)}`,
      error: true,
    };
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
