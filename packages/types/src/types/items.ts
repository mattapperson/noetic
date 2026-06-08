import type * as OpenRouterAgent from '@openrouter/agent';
import type { ZodTypeAny, z } from 'zod';

//#region Provider Types

type ResponseOutputText = OpenRouterAgent.ResponseOutputText;
type ResponsesImageGenerationCall = OpenRouterAgent.OutputImageGenerationCallItem;
type ResponsesOutputItemFileSearchCall = OpenRouterAgent.OutputFileSearchCallItem;
type ResponsesOutputItemFunctionCall = OpenRouterAgent.OutputFunctionCallItem;
type ResponsesOutputItemReasoning = OpenRouterAgent.OutputReasoningItem;
type ResponsesOutputMessage = OpenRouterAgent.OutputMessage;
type ResponsesWebSearchCallOutput = OpenRouterAgent.OutputWebSearchCallItem;
type ResponsesServerToolOutput = Exclude<
  OpenRouterAgent.OpenResponsesResult['output'][number],
  | OpenRouterAgent.OutputMessage
  | OpenRouterAgent.OutputFunctionCallItem
  | OpenRouterAgent.OutputReasoningItem
  | OpenRouterAgent.OutputWebSearchCallItem
  | OpenRouterAgent.OutputFileSearchCallItem
  | OpenRouterAgent.OutputImageGenerationCallItem
>;
type OutputMessageContentPart = OpenRouterAgent.OutputMessage['content'][number];
type OpenAIResponsesRefusalContent = Extract<
  OutputMessageContentPart,
  {
    type: 'refusal';
  }
>;
type ReasoningContentPart = NonNullable<OpenRouterAgent.OutputReasoningItem['content']>[number];
type SummaryContentPart = NonNullable<OpenRouterAgent.OutputReasoningItem['summary']>[number];
type ReasoningTextContent = Extract<
  ReasoningContentPart,
  {
    type: 'reasoning_text';
  }
>;
type ReasoningSummaryText = Extract<
  SummaryContentPart,
  {
    type: 'summary_text';
  }
>;

//#endregion

//#region Content Parts

/** @public Model-generated text content with optional annotations and logprobs. */
export type OutputTextPart = ResponseOutputText;

/** @public Model refusal content. */
export type RefusalPart = OpenAIResponsesRefusalContent;

/** @public User/developer input text (framework-created, not from SDK). */
export interface InputTextPart {
  readonly type: 'input_text';
  readonly text: string;
}

/** @public User image input content. */
export interface InputImagePart {
  readonly type: 'input_image';
  readonly imageUrl: string;
  readonly detail?: 'auto' | 'low' | 'high';
}

/** @public User file input content. */
export interface InputFilePart {
  readonly type: 'input_file';
  readonly fileData?: string;
  readonly fileId?: string | null;
  readonly fileUrl?: string;
  readonly filename?: string;
}

/** @public Reasoning trace content. */
export type ReasoningTextPart = ReasoningTextContent;

/** @public Reasoning summary content. */
export type SummaryTextPart = ReasoningSummaryText;

/** @public User/developer input content variants. */
export type InputContentPart = InputTextPart | InputImagePart | InputFilePart;

/** @public Content part variants for message items. */
export type ContentPart = OutputTextPart | RefusalPart | InputContentPart;

//#endregion

//#region Output Items (from model — extends provider types)

/** @public Assistant message output item. */
export type MessageItem = ResponsesOutputMessage;

/** @public Function call requested by the model. */
export type FunctionCallItem = ResponsesOutputItemFunctionCall;

/** @public Reasoning trace from the model. */
export type ReasoningItem = ResponsesOutputItemReasoning;

/** @public Web search call result. */
export type WebSearchItem = ResponsesWebSearchCallOutput;

/** @public File search call result. */
export type FileSearchItem = ResponsesOutputItemFileSearchCall;

/** @public Image generation call result. */
export type ImageGenerationItem = ResponsesImageGenerationCall;

/**
 * @public Server tool output (vendor-prefixed type like `openrouter:datetime`).
 * Constrains provider output items to the vendor-prefixed subset so discriminant narrowing works in Item unions.
 */
export type ServerToolItem = Omit<ResponsesServerToolOutput, 'type'> & {
  readonly type: `${string}:${string}`;
};

//#endregion

//#region Framework Items (created by Noetic, not from provider)

/** @public Base shape required for framework and extension items. */
export interface ItemBase {
  readonly type: string;
}

/**
 * @public Input message created by the framework (user, system, or developer role).
 * Status includes `failed` as a Noetic extension beyond the Open Responses spec
 * (which only defines `in_progress | completed | incomplete` for items).
 */
export interface InputMessageItem {
  readonly id: string;
  readonly type: 'message';
  readonly role: 'user' | 'system' | 'developer';
  readonly status: 'in_progress' | 'completed' | 'incomplete' | 'failed';
  readonly content: InputContentPart[];
}

/**
 * @public Tool execution output created by the harness during the tool loop.
 * This is an input-only item type in Open Responses (sent by the developer, not the model).
 */
export interface FunctionCallOutputItem {
  readonly id: string;
  readonly type: 'function_call_output';
  readonly status: 'in_progress' | 'completed' | 'incomplete' | 'failed';
  readonly callId: string;
  readonly output: string;
}

/** @public Item produced by an extension schema registered by a tool, memory layer, or harness. */
export type ExtensionItem = ItemBase & Record<string, unknown>;

/** @public Developer-role message item refined by a memory-layer extension schema. */
export type DeveloperMessageExtensionItem = InputMessageItem & {
  readonly role: 'developer';
} & Record<string, unknown>;

/** @public Function-call item refined by a tool extension schema. */
export type ToolCallExtensionItem = FunctionCallItem & Record<string, unknown>;

/** @public Function-call output item refined by a tool extension schema. */
export type ToolResultExtensionItem = FunctionCallOutputItem & Record<string, unknown>;

/** @public Zod schemas that extend the runtime `Item` union. */
export interface ItemSchemaExtensions {
  /** Harness-wide schemas. Any item matching one of these schemas is accepted. */
  readonly items?: ReadonlyArray<ZodTypeAny>;
  /** Schemas for memory-layer developer message items. */
  readonly developerMessages?: ReadonlyArray<ZodTypeAny>;
  /** Schemas for tool call items emitted by the model or a harness adapter. */
  readonly toolCalls?: ReadonlyArray<ZodTypeAny>;
  /** Schemas for tool result items emitted by the harness or a tool adapter. */
  readonly toolResults?: ReadonlyArray<ZodTypeAny>;
}

/** @public Type inferred from an `ItemSchemaExtensions` declaration. */
export type InferExtendedItem<TExtensions extends ItemSchemaExtensions | undefined> =
  TExtensions extends ItemSchemaExtensions
    ?
        | (TExtensions['items'] extends ReadonlyArray<infer S extends ZodTypeAny>
            ? z.infer<S>
            : never)
        | (TExtensions['developerMessages'] extends ReadonlyArray<infer S extends ZodTypeAny>
            ? z.infer<S>
            : never)
        | (TExtensions['toolCalls'] extends ReadonlyArray<infer S extends ZodTypeAny>
            ? z.infer<S>
            : never)
        | (TExtensions['toolResults'] extends ReadonlyArray<infer S extends ZodTypeAny>
            ? z.infer<S>
            : never)
    : never;

/** @public Item union extended by a concrete `ItemSchemaExtensions` declaration. */
export type ExtendedItem<TExtensions extends ItemSchemaExtensions | undefined> =
  | Item
  | InferExtendedItem<TExtensions>;

//#endregion

//#region Union Types

/** @public All output item types from the model (Open Responses compliant). */
export type OutputItem =
  | MessageItem
  | FunctionCallItem
  | ReasoningItem
  | WebSearchItem
  | FileSearchItem
  | ImageGenerationItem
  | ServerToolItem;

/** @public All item types that can appear in an ItemLog. */
export type Item = OutputItem | InputMessageItem | FunctionCallOutputItem;

/** @public Accepted input types for `AgentHarness.execute()`: a plain string, a single Item, or an array of Items. */
export type ExecuteInput = string | Item | Item[];

//#endregion
