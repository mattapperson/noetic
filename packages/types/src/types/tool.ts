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
  init(): TState;
  /**
   * Project state into the LLM context. Return null to omit.
   * Declared as a method (bivariant params) so a concrete
   * `ToolMemoryDeclaration<MyState>` assigns to the erased
   * `ToolMemoryDeclaration` the `tool()` builder and runtime consume.
   */
  recall(state: TState): string | null;
}

/**
 * A renderable UI fragment in a named dialect (e.g. `'openui-lang/0.5'`).
 * The framework never interprets `source` — it forwards fragments as
 * `openui.fragment` framework events and attaches them to items; a UI
 * surface (memory layer + transport) composes and renders them.
 * @public
 */
export interface UiFragment {
  /** Dialect identifier, e.g. `'openui-lang/0.5'`. */
  dialect: string;
  /** Fragment source in that dialect, e.g. `'root = Card([Spinner()])'`. */
  source: string;
}

/**
 * Declares tool-owned UI: programmatic render functions invoked at tool
 * lifecycle points. All methods are optional — an omitted point renders
 * nothing (mirrors `ToolMemoryDeclaration`). Declared as methods (bivariant
 * params) so a concretely-typed declaration assigns to the erased form the
 * `tool()` builder and runtime consume.
 * @public
 */
export interface ToolUiDeclaration<
  I extends ZodTypeAny = ZodTypeAny,
  O extends ZodTypeAny = ZodTypeAny,
  E = unknown,
> {
  /** Rendered as soon as the call streams in — args may be partial. */
  call?(args: Partial<z.infer<I>>): UiFragment | null;
  /** Re-rendered on each event an AsyncGenerator `execute` yields. Receives all events so far. */
  progress?(events: E[]): UiFragment | null;
  /** Replaces the tool's region on successful completion. */
  result?(output: z.infer<O>, args: z.infer<I>): UiFragment | null;
  /** Replaces the tool's region when execution throws. */
  error?(err: unknown, args: z.infer<I>): UiFragment | null;
}

/**
 * A tool definition that an LLM can invoke during execution.
 *
 * The runtime passes a `ToolExecutionContext` (from `./tool-context`) as
 * the second argument to `execute`. Callers that need the concrete type
 * should import `Tool` from the package root (`@noetic-tools/core`), which
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
  /** Optional UI declaration — the runtime emits the rendered fragments at call/progress/result points. */
  ui?: ToolUiDeclaration<I, O>;
}
