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
  ToolResultExtensionItem,
  ToolUiDeclaration,
} from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';

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
  needsApproval?: boolean;
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
  needsApproval?: boolean;
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
    execute: config.execute,
    needsApproval: config.needsApproval,
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
    execute: config.execute,
    needsApproval: config.needsApproval,
    context: config.context,
    ui: config.ui,
    acp: config.acp,
  };
}

//#endregion
