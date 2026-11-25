import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  InputFilePart,
  InputImagePart,
  InputTextPart,
  Item,
  ItemSchemaExtensions,
  ToolResultExtensionItem,
} from './items';
import type { InferSchemaOutput } from './schema';
import type {
  ToolCallProgress,
  ToolContent,
  ToolIdentity,
  ToolKind,
  ToolLocation,
} from './tool-activity';

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
  /** Re-rendered on each event an AsyncGenerator `execute` yields. Receives all events so far. */
  progress?(events: E[]): UiFragment | null;
  /** Replaces the tool's region on successful completion. */
  result?(output: InferSchemaOutput<O>, args: InferSchemaOutput<I>): UiFragment | null;
  /** Replaces the tool's region when execution throws. */
  error?(err: unknown, args: InferSchemaOutput<I>): UiFragment | null;
}

/**
 * How a call to a tool presents to a host: a human title, its kind, the files
 * it touches, what it reports while it runs, and what it produced as
 * structure (a diff, an image). The runtime puts these on the call's events
 * (`tool_call_started`, `tool_progress`, `tool_call_completed`; spec 08), the
 * same fields an agent's own calls carry, so a host shows a tool's calls and
 * an agent's alike; a served harness shows them in its client's editor.
 *
 * Presentation only — it never gates anything. An undeclared tool presents by
 * its name alone. Declared as methods (bivariant params) for the same reason
 * as `ToolUiDeclaration`. A method that throws presents nothing for that point.
 * @public
 */
export interface ToolPresentationDeclaration<
  I extends StandardSchemaV1 = StandardSchemaV1,
  O extends StandardSchemaV1 = StandardSchemaV1,
  E = unknown,
> {
  /**
   * Which tool a call is to, when it is not the tool's own `name`: an MCP
   * tool's name on its server, and the server — what an agent calling the same
   * MCP tool reports — so a host grouping calls by tool sees one tool. A
   * function receives the call's parsed args (a tool that reaches one of
   * several servers). Defaults to `{ id: name }`.
   */
  identity?: ToolIdentity | ToolIdentityFn<I>;
  /** What kind of work a call does (`read`, `edit`, `execute`, …). */
  kind?: ToolKind;
  /** Human-readable title; a function receives the call's parsed args. */
  title?: string | ToolTitleFn<I>;
  /** The files a call works on: paths, or paths with a line. */
  locations?(args: InferSchemaOutput<I>): Array<string | ToolLocation>;
  /**
   * What a running call reports, on each event an AsyncGenerator `execute`
   * yields. Receives all events so far; null reports nothing for this one.
   */
  progress?(events: E[]): ToolCallProgress | null;
  /** What a call that did not fail produced, as structure: diffs, images, resources. */
  content?(output: InferSchemaOutput<O>, args: InferSchemaOutput<I>): ToolContent[];
}

/**
 * Bivariant function type for `ToolPresentationDeclaration.identity`; see
 * {@link ToolTitleFn}.
 * @public
 */
export type ToolIdentityFn<I extends StandardSchemaV1 = StandardSchemaV1> = {
  bivariant(args: InferSchemaOutput<I>): ToolIdentity;
}['bivariant'];

/**
 * Bivariant function type for `ToolPresentationDeclaration.title` — a union
 * member cannot use method syntax, so the method-bearing object type is
 * indexed to recover the same bivariance `ToolUiDeclaration`'s methods get,
 * keeping a concretely-typed tool assignable to the erased `Tool` form.
 * @public
 */
export type ToolTitleFn<I extends StandardSchemaV1 = StandardSchemaV1> = {
  bivariant(args: InferSchemaOutput<I>): string;
}['bivariant'];

/**
 * @public
 * @deprecated Use {@link ToolPresentationDeclaration} (`Tool.presentation`),
 * which every host reads, not only a served ACP client.
 */
export type ToolAcpDeclaration<I extends StandardSchemaV1 = StandardSchemaV1> = Pick<
  ToolPresentationDeclaration<I>,
  'kind' | 'title'
> & {
  locations?(args: InferSchemaOutput<I>): string[];
};

/**
 * @public
 * @deprecated Use {@link ToolTitleFn}.
 */
export type ToolAcpTitleFn<I extends StandardSchemaV1 = StandardSchemaV1> = ToolTitleFn<I>;

/**
 * @public What `Tool.toModelOutput` returns: the text, or the content parts, the
 * model is given as a tool call's result. The Agent SDK accepts text, images,
 * and files in tool results.
 */
export type ToolModelOutput =
  | string
  | ReadonlyArray<InputTextPart | InputImagePart | InputFilePart>;

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
   * What the model is given as this call's result, in place of the result's JSON
   * text: text, or content parts such as an image. Called for a call that did not
   * fail, with the tool's result and the call's arguments. The result item, the
   * `tool_call_completed` event and the call's record keep the JSON output, so a
   * resumed run calls this again with the recorded result: keep it a pure function
   * of its arguments. Live and on replay, `result` is the result's JSON round trip
   * (a `Date` arrives as its ISO text) and `args` the arguments as the input schema
   * reads them. If it throws, the model is given the JSON output.
   */
  toModelOutput?(result: InferSchemaOutput<O>, args: InferSchemaOutput<I>): ToolModelOutput;
  /**
   * Async function that performs the tool's work. `toolCtx` is a
   * `ToolExecutionContext` at runtime — typed as `unknown` here to keep
   * this type a dependency leaf. Use `tool()` from `builders/` or cast at
   * the call site to get a typed handle.
   */
  execute(args: InferSchemaOutput<I>, toolCtx: unknown): ToolExecutionResult<O>;
  /**
   * Every call needs approval before it runs. The harness asks its
   * `approveToolCall` approver after the `beforeToolCall` layers allow the
   * call. With no approver configured the call is held until
   * a decision passed to `harness.execute()` answers it (spec 08 § Held tool calls).
   */
  needsApproval?: boolean;
  /**
   * How a call to this tool behaves when a run is resumed, as `durable` does for a
   * step (spec 23a § Tool calls in a round).
   *
   * - unset: the call's result is recorded. A call that was running when the host
   *   died runs again, with the same `idempotencyKey`.
   * - `true`: the call has a lasting effect and must not be repeated unasked. A
   *   call that was running when the host died is held as `outcome` until a
   *   person says whether it landed (spec 08 § Held tool calls).
   * - `false`: the result is not recorded, so the call runs again on every resume.
   *   For a cheap read whose answer should be fresh.
   */
  durable?: boolean;
  /** Optional context declaration — the runtime generates a ContextLayer from this. */
  context?: ToolContextDeclaration;
  /** Optional UI declaration — the runtime emits the rendered fragments at call/progress/result points. */
  ui?: ToolUiDeclaration<I, O>;
  /** How a call presents to a host: title, kind, files, progress, structured results. */
  presentation?: ToolPresentationDeclaration<I, O>;
  /** @deprecated Use `presentation`, read in its place when `presentation` is absent. */
  acp?: ToolAcpDeclaration<I>;
}
