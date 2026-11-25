import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  InferSchemaOutput,
  InputSchemaConfig,
  Item,
  ItemSchemaExtensions,
  StandardSchemaV1,
  Tool,
  ToolAcpDeclaration,
  ToolContextDeclaration,
  ToolExecutionContext,
  ToolHold,
  ToolModelOutput,
  ToolResultExtensionItem,
  ToolUiDeclaration,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';

//#region Types

type ToolConfig<I extends StandardSchemaV1, O extends StandardSchemaV1> = {
  name: string;
  description: string;
  input: I;
  output: O;
  itemSchemas?: Pick<ItemSchemaExtensions, 'toolCalls' | 'toolResults' | 'items'>;
  decorateResultItem?: (params: {
    baseItem: FunctionCallOutputItem;
    callItem: FunctionCallItem;
    args: InferSchemaOutput<I>;
    result: InferSchemaOutput<O> | undefined;
    output: string;
    error?: boolean;
  }) => Item | ToolResultExtensionItem;
  execute: (
    args: InferSchemaOutput<I>,
    toolCtx: ToolExecutionContext,
  ) => Promise<InferSchemaOutput<O>>;
  /** See `Tool.toModelOutput`: what the model is given as the result, e.g. an image. */
  toModelOutput?: (result: InferSchemaOutput<O>, args: InferSchemaOutput<I>) => ToolModelOutput;
  needsApproval?: boolean;
  /** See `Tool.durable`: `true` holds an interrupted call for a person, `false` records nothing. */
  durable?: boolean;
  /** Optional context declaration — the runtime generates a ContextLayer from this via toolCalls(). */
  context?: ToolContextDeclaration;
  /** Optional UI declaration — the runtime emits the rendered fragments at call/progress/result points. */
  ui?: ToolUiDeclaration<I, O>;
  /** Optional ACP presentation — how the call renders in an ACP client when the harness is served as an agent. */
  acp?: ToolAcpDeclaration<I>;
} & InputSchemaConfig<I>;

type GeneratorToolConfig<
  I extends StandardSchemaV1,
  E extends StandardSchemaV1,
  O extends StandardSchemaV1,
> = {
  name: string;
  description: string;
  input: I;
  event: E;
  output: O;
  itemSchemas?: Pick<ItemSchemaExtensions, 'toolCalls' | 'toolResults' | 'items'>;
  decorateResultItem?: (params: {
    baseItem: FunctionCallOutputItem;
    callItem: FunctionCallItem;
    args: InferSchemaOutput<I>;
    result: InferSchemaOutput<O> | undefined;
    output: string;
    error?: boolean;
  }) => Item | ToolResultExtensionItem;
  execute: (
    args: InferSchemaOutput<I>,
    toolCtx: ToolExecutionContext,
  ) => AsyncGenerator<InferSchemaOutput<E>, InferSchemaOutput<O>>;
  /** See `Tool.toModelOutput`: what the model is given as the result, e.g. an image. */
  toModelOutput?: (result: InferSchemaOutput<O>, args: InferSchemaOutput<I>) => ToolModelOutput;
  needsApproval?: boolean;
  /** See `Tool.durable`: `true` holds an interrupted call for a person, `false` records nothing. */
  durable?: boolean;
  /** Optional context declaration — the runtime generates a ContextLayer from this via toolCalls(). */
  context?: ToolContextDeclaration;
  /** Optional UI declaration — the runtime emits the rendered fragments at call/progress/result points. */
  ui?: ToolUiDeclaration<I, O, InferSchemaOutput<E>>;
  /** Optional ACP presentation — how the call renders in an ACP client when the harness is served as an agent. */
  acp?: ToolAcpDeclaration<I>;
} & InputSchemaConfig<I>;

//#endregion

//#region Helpers

function validateToolConfig(name: string, execute: unknown): void {
  if (!name || name.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_TOOL_NAME',
      message: 'tool() requires a non-empty name.',
      hint: "Pass a unique name for the tool, e.g. tool({ name: 'greet', ... }).",
    });
  }

  if (!execute) {
    throw new NoeticConfigError({
      code: 'MISSING_EXECUTE_FUNCTION',
      message: 'tool() requires an execute function.',
      hint: 'Provide an async execute function, e.g. execute: async (args, toolCtx) => result.',
    });
  }
}

//#endregion

//#region Public API

/**
 * Creates a typed Tool with Standard Schema inference for input and output.
 * Accepts Zod, Valibot, or any Standard Schema v1 implementation.
 *
 * @public
 * @throws `NoeticConfigError` with code `EMPTY_TOOL_NAME` if `name` is empty.
 * @throws `NoeticConfigError` with code `MISSING_EXECUTE_FUNCTION` if `execute` is not provided.
 */
export function tool<I extends StandardSchemaV1, O extends StandardSchemaV1>(
  config: ToolConfig<I, O>,
): Tool<I, O> {
  validateToolConfig(config.name, config.execute);

  return {
    name: config.name,
    description: config.description,
    input: config.input,
    output: config.output,
    inputJsonSchema: config.inputJsonSchema,
    itemSchemas: config.itemSchemas,
    decorateResultItem: config.decorateResultItem,
    toModelOutput: config.toModelOutput,
    execute: config.execute,
    needsApproval: config.needsApproval,
    durable: config.durable,
    context: config.context,
    ui: config.ui,
    acp: config.acp,
  };
}

/**
 * Creates a typed Tool that can stream progress events before returning a final output.
 *
 * @public
 */
export function toolWithGenerator<
  I extends StandardSchemaV1,
  E extends StandardSchemaV1,
  O extends StandardSchemaV1,
>(config: GeneratorToolConfig<I, E, O>): Tool<I, O> {
  validateToolConfig(config.name, config.execute);

  return {
    name: config.name,
    description: config.description,
    input: config.input,
    event: config.event,
    output: config.output,
    inputJsonSchema: config.inputJsonSchema,
    itemSchemas: config.itemSchemas,
    decorateResultItem: config.decorateResultItem,
    toModelOutput: config.toModelOutput,
    execute: config.execute,
    needsApproval: config.needsApproval,
    durable: config.durable,
    context: config.context,
    ui: config.ui,
    acp: config.acp,
  };
}

//#endregion

/**
 * @public
 * What a tool returns to leave its result open for a person
 * (spec 08 § Held tool calls). The tool has done its part — posted the question,
 * opened the ticket — and the answer becomes the call's result when
 * a decision passed to `harness.execute()` gives one. The tool body does not run again.
 *
 * @param options - `request` is passed to whoever answers, as `HeldCall.request`.
 *   `dueAt` (epoch ms) ends the hold; `onDue` says how: `deny` (the default)
 *   fails the call, `keep` leaves it held.
 */
export function hold<O = never>(options?: {
  request?: unknown;
  dueAt?: number;
  onDue?: 'deny' | 'keep';
}): O {
  const held: ToolHold = {
    kind: 'noetic/tool-hold',
    ...options,
  };
  // Typed as the tool's own output so `return hold()` fits any `execute`. The
  // harness takes it out before anything reads it as a result.
  return frameworkCast<O>(held);
}
