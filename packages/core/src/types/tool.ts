import type { ZodTypeAny, z } from 'zod';
import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  Item,
  ItemSchemaExtensions,
  ToolResultExtensionItem,
} from './items';

type ToolExecutionResult<O extends ZodTypeAny> =
  | Promise<z.infer<O>>
  | AsyncGenerator<unknown, z.infer<O>>;

/**
 * Declares tool-owned memory that the runtime materializes into a MemoryLayer.
 * @public
 */
export interface ToolMemoryDeclaration<TState = unknown> {
  /** Shared id — tools with the same id share state. Defaults to `tool.name`. */
  id?: string;
  /** Factory for the initial state. */
  init: () => TState;
  /** Project state into the LLM context. Return null to omit. */
  recall: (state: TState) => string | null;
}

/**
 * A tool definition that an LLM can invoke during execution.
 *
 * The runtime passes a `ToolExecutionContext` (from `./tool-context`) as
 * the second argument to `execute`. Callers that need the concrete type
 * should import `Tool` from the package root (`@noetic/core`), which
 * re-exports it with `ToolExecutionContext` substituted in.
 * @public
 */
export interface Tool<I extends ZodTypeAny = ZodTypeAny, O extends ZodTypeAny = ZodTypeAny> {
  /** Unique tool name used by the LLM for selection. */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** Zod schema validating tool input arguments. */
  input: I;
  /** Zod schema validating tool return value. */
  output: O;
  /** Optional Zod schema validating streaming events yielded during execution. */
  event?: ZodTypeAny;
  /** Optional item schemas contributed by this tool for tool call/result extensions. */
  itemSchemas?: Pick<ItemSchemaExtensions, 'toolCalls' | 'toolResults' | 'items'>;
  /** Decorate the harness-created tool result item before it is appended/emitted. */
  decorateResultItem?(params: {
    baseItem: FunctionCallOutputItem;
    callItem: FunctionCallItem;
    args: z.infer<I>;
    result: z.infer<O> | undefined;
    output: string;
    error?: boolean;
  }): Item | ToolResultExtensionItem;
  /**
   * Async function that performs the tool's work. `toolCtx` is a
   * `ToolExecutionContext` at runtime — typed as `unknown` here to keep
   * this type a dependency leaf. Use `tool()` from `builders/` or cast at
   * the call site to get a typed handle.
   */
  execute(args: z.infer<I>, toolCtx: unknown): ToolExecutionResult<O>;
  /** When true, execution pauses for human approval before running. */
  needsApproval?: boolean;
  /** Optional memory declaration — the runtime generates a MemoryLayer from this. */
  memory?: ToolMemoryDeclaration;
}
