import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AcpToolKind } from './acp';
import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  Item,
  ItemSchemaExtensions,
  ToolResultExtensionItem,
} from './items';
import type { InferSchemaOutput } from './schema';

type ToolExecutionResult<O extends StandardSchemaV1> =
  | Promise<InferSchemaOutput<O>>
  | AsyncGenerator<unknown, InferSchemaOutput<O>>;

/**
 * Declares tool-owned state that the runtime materializes into a ContextLayer.
 * @public
 */
export interface ToolContextDeclaration<TState = unknown> {
  /** Shared id — tools with the same id share state. Defaults to `tool.name`. */
  id?: string;
  /** Factory for the initial state. */
  init(): TState;
  /**
   * Project state into the LLM context. Return null to omit.
   * Declared as a method (bivariant params) so a concrete
   * `ToolContextDeclaration<MyState>` assigns to the erased
   * `ToolContextDeclaration` the `tool()` builder and runtime consume.
   */
  recall(state: TState): string | null;
}

/**
 * A renderable UI fragment in a named dialect (e.g. `'openui-lang/0.5'`).
 * The framework never interprets `source` — it forwards fragments as
 * `openui.fragment` framework events and attaches them to items; a UI
 * surface (context layer + transport) composes and renders them.
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
 * nothing (mirrors `ToolContextDeclaration`). Declared as methods (bivariant
 * params) so a concretely-typed declaration assigns to the erased form the
 * `tool()` builder and runtime consume.
 * @public
 */
export interface ToolUiDeclaration<
  I extends StandardSchemaV1 = StandardSchemaV1,
  O extends StandardSchemaV1 = StandardSchemaV1,
  E = unknown,
> {
  /** Rendered as soon as the call streams in — args may be partial. */
  call?(args: Partial<InferSchemaOutput<I>>): UiFragment | null;
  /** Re-rendered on each AsyncGenerator yield. Receives only the latest event (single-element array). */
  progress?(events: E[]): UiFragment | null;
  /** Replaces the tool's region on successful completion. */
  result?(output: InferSchemaOutput<O>, args: InferSchemaOutput<I>): UiFragment | null;
  /** Replaces the tool's region when execution throws. */
  error?(err: unknown, args: InferSchemaOutput<I>): UiFragment | null;
}

/**
 * How a tool call presents in an ACP client's UI when the harness is served
 * as an ACP agent (`toAcpAgent`/`serveAcp` in `@noetic-tools/acp`).
 *
 * Presentation only — it never gates anything. An undeclared tool falls back
 * to kind `other` with its name as the title. Declared as methods (bivariant
 * params) for the same reason as `ToolUiDeclaration`.
 * @public
 */
export interface ToolAcpDeclaration<I extends StandardSchemaV1 = StandardSchemaV1> {
  /** ACP tool kind (`read`, `edit`, `execute`, …) for editor rendering. */
  kind?: AcpToolKind;
  /** Human-readable title; a function receives the call's parsed args. */
  title?: string | ToolAcpTitleFn<I>;
  /** File paths the call affects, surfaced as ACP `locations`. */
  locations?(args: InferSchemaOutput<I>): string[];
}

/**
 * Bivariant function type for `ToolAcpDeclaration.title` — a union member
 * cannot use method syntax, so the method-bearing object type is indexed to
 * recover the same bivariance `ToolUiDeclaration`'s methods get, keeping a
 * concretely-typed tool assignable to the erased `Tool` form.
 * @public
 */
export type ToolAcpTitleFn<I extends StandardSchemaV1 = StandardSchemaV1> = {
  bivariant(args: InferSchemaOutput<I>): string;
}['bivariant'];

/**
 * A tool definition that an LLM can invoke during execution.
 *
 * Input and output schemas accept any Standard Schema v1 implementation
 * (Zod, Valibot, ArkType, …). Zod remains the fast path; other validators
 * can provide JSON Schema through the Standard JSON Schema v1 companion
 * trait or an explicit `inputJsonSchema` override.
 *
 * The runtime passes a `ToolExecutionContext` (from `./tool-context`) as
 * the second argument to `execute`. Callers that need the concrete type
 * should import `Tool` from the package root (`@noetic-tools/core`), which
 * re-exports it with `ToolExecutionContext` substituted in.
 * @public
 */
export interface Tool<
  I extends StandardSchemaV1 = StandardSchemaV1,
  O extends StandardSchemaV1 = StandardSchemaV1,
> {
  /** Unique tool name used by the LLM for selection. */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** Schema validating tool input arguments (any Standard Schema v1). */
  input: I;
  /** Schema validating tool return value (any Standard Schema v1). */
  output: O;
  /**
   * Explicit raw JSON Schema for the tool input, sent to the LLM wire format.
   * For non-Zod schemas, overrides StandardJSONSchemaV1 conversion and serves
   * as the required fallback for validation-only schemas.
   */
  inputJsonSchema?: Record<string, unknown>;
  /** Optional schema validating streaming events yielded during execution. */
  event?: StandardSchemaV1;
  /** Optional item schemas contributed by this tool for tool call/result extensions. */
  itemSchemas?: Pick<ItemSchemaExtensions, 'toolCalls' | 'toolResults' | 'items'>;
  /** Decorate the harness-created tool result item before it is appended/emitted. */
  decorateResultItem?(params: {
    baseItem: FunctionCallOutputItem;
    callItem: FunctionCallItem;
    args: InferSchemaOutput<I>;
    result: InferSchemaOutput<O> | undefined;
    output: string;
    error?: boolean;
  }): Item | ToolResultExtensionItem;
  /**
   * Async function that performs the tool's work. `toolCtx` is a
   * `ToolExecutionContext` at runtime — typed as `unknown` here to keep
   * this type a dependency leaf. Use `tool()` from `builders/` or cast at
   * the call site to get a typed handle.
   */
  execute(args: InferSchemaOutput<I>, toolCtx: unknown): ToolExecutionResult<O>;
  /** When true, execution pauses for human approval before running. */
  needsApproval?: boolean;
  /** Optional context declaration — the runtime generates a ContextLayer from this. */
  context?: ToolContextDeclaration;
  /** Optional UI declaration — the runtime emits the rendered fragments at call/progress/result points. */
  ui?: ToolUiDeclaration<I, O>;
  /** Optional ACP presentation — how the call renders in an ACP client when the harness is served as an agent. */
  acp?: ToolAcpDeclaration<I>;
}
