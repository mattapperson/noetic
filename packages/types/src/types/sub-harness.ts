/**
 * Coding-agent harness contract.
 *
 * A "harness" here is a pluggable backend that drives an external agentic
 * coding tool — Claude Code, Codex, opencode, pi — as a Noetic step. It is the
 * direct analogue of the `MemoryLayer` contract: defined in the dependency-free
 * `@noetic-tools/types` foundation so both `@noetic-tools/core` (which executes
 * harness steps) and the per-tool `@noetic-tools/sub-harness-*` packages (which
 * implement them) can depend on it without forming a cycle.
 *
 * Modelled on Vercel's `HarnessV1` spec: a tagged spec version, a small set of
 * descriptive fields, and a single `doStart` entry point that yields a session.
 * Optional capabilities are signalled by the presence of optional methods, not
 * a static capabilities object — an adapter that cannot satisfy a request
 * throws {@link SubHarnessCapabilityError} from the relevant method.
 */

import { z } from 'zod';
import type { TokenUsage } from './common';
import type { FsAdapter } from './fs-adapter';
import type { Item } from './items';
import type { ShellAdapter } from './shell-adapter';
import type { SubprocessAdapter } from './subprocess-adapter';

//#region Step-kind discriminator

/**
 * The set of harness step kinds. Each value is a distinct `Step.kind`, so a
 * `step.claudeCode(...)` and a `step.codex(...)` are separate, individually
 * typed step variants — while the interpreter routes all of them through a
 * single shared `executeSubHarness` handler.
 * @public
 */
export const SubHarnessKind = {
  ClaudeCode: 'claude-code',
  Codex: 'codex',
  Opencode: 'opencode',
  Pi: 'pi',
} as const;

/** @public Union of all harness step kinds. */
export type SubHarnessKind = (typeof SubHarnessKind)[keyof typeof SubHarnessKind];

/** @public Ordered list of every harness kind — the single source of truth consumed by the JSON schema and the interpreter. */
export const SUB_HARNESS_KINDS: ReadonlyArray<SubHarnessKind> = [
  SubHarnessKind.ClaudeCode,
  SubHarnessKind.Codex,
  SubHarnessKind.Opencode,
  SubHarnessKind.Pi,
];

//#endregion

//#region Settings + policies

/**
 * Settings shared by every harness step. Tool-specific knobs that don't map to
 * a shared concept go through `extra`, which each adapter interprets (and may
 * reject with {@link SubHarnessCapabilityError}).
 * @public
 */
export interface SubHarnessSettings {
  /** Model identifier for the underlying agent (e.g. `claude-opus-4-8`). */
  model?: string;
  /** Permission posture for tool/file mutations the agent attempts. */
  permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
  /** Hard cap on internal agent turns before it must yield. */
  maxTurns?: number;
  /** Restrict the agent to this set of built-in tool names. */
  allowedTools?: ReadonlyArray<string>;
  /** Tool-specific passthrough options interpreted by the adapter. */
  extra?: Record<string, unknown>;
}

/**
 * Controls how a harness session is reused and torn down across steps.
 * @public
 */
export interface SubHarnessSessionPolicy {
  /**
   * Reuse a live session keyed by this id across multiple harness steps. When
   * omitted, each step gets a fresh session that is stopped on completion.
   */
  reuse?: string;
  /**
   * Lifecycle action when the step completes. `'stop'` (default) persists state
   * and stops the runtime; `'detach'` parks it for later resume; `'destroy'`
   * discards it with no resume state.
   */
  onComplete?: 'stop' | 'detach' | 'destroy';
}

//#endregion

//#region Stream parts (adapter event model)

/** @public Why an agentic turn ended. */
export type SubHarnessFinishReason = 'stop' | 'length' | 'aborted' | 'error' | 'tool-calls';

const HarnessFinishReasonSchema = z.enum([
  'stop',
  'length',
  'aborted',
  'error',
  'tool-calls',
]);

const TokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  total: z.number().optional(),
  cached: z.number().optional(),
});

/**
 * Runtime validation schema for {@link SubHarnessStreamPart}. Adapters that move
 * events across a process or transport boundary (e.g. a sandbox bridge)
 * validate with this before forwarding.
 * @public
 */
export const SubHarnessStreamPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stream-start'),
  }),
  z.object({
    type: z.literal('text-delta'),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('reasoning-delta'),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('tool-call'),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    /** True when the underlying agent executed the tool itself (vs. host dispatch). */
    providerExecuted: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('tool-result'),
    toolCallId: z.string(),
    toolName: z.string(),
    output: z.unknown(),
    isError: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('file-change'),
    path: z.string().optional(),
    summary: z.string().optional(),
  }),
  z.object({
    type: z.literal('finish'),
    finishReason: HarnessFinishReasonSchema,
    usage: TokenUsageSchema.optional(),
    cost: z.number().optional(),
  }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
  }),
  /** Adapter-specific passthrough for events with no canonical mapping. */
  z.object({
    type: z.literal('raw'),
    value: z.unknown(),
  }),
]);

/**
 * A single event emitted by a harness during a turn. Mirrors the model-stream
 * primitives so the interpreter can forward them as framework events with
 * minimal translation. Adapter-specific metadata rides on `raw`.
 * @public
 */
export type SubHarnessStreamPart = z.infer<typeof SubHarnessStreamPartSchema>;

//#endregion

//#region Run context + turn IO

/**
 * The workspace surface a harness session may touch during a turn. A focused
 * subset of {@link Context} so adapters don't depend on the full runtime type.
 * @public
 */
export interface SubHarnessRunContext {
  /** Working directory the agent runs in (resolved from `ctx.cwdState.cwd`). */
  readonly cwd: string;
  readonly fs: FsAdapter;
  readonly shell: ShellAdapter;
  readonly subprocess: SubprocessAdapter;
  /** Conversation thread id, for adapters that persist per-thread session state. */
  readonly threadId: string;
  /** Abort signal for the surrounding execution. */
  readonly signal?: AbortSignal;
}

/** @public Opaque, adapter-defined state for resuming a stopped/detached session. */
export interface SubHarnessResumeState {
  readonly harnessId: string;
  readonly sessionId: string;
  readonly state: unknown;
}

/** @public Opaque, adapter-defined state for continuing a turn frozen mid-flight. */
export interface SubHarnessContinueState {
  readonly harnessId: string;
  readonly sessionId: string;
  readonly state: unknown;
}

/** @public Options handed to {@link SubHarness.doStart}. */
export interface SubHarnessStartOptions<TSettings = SubHarnessSettings> {
  /** Per-step settings (model, permission mode, …). */
  settings?: TSettings;
  /**
   * System instructions applied once on the first message of a fresh session.
   * Never re-applied on resume.
   */
  instructions?: string;
  /**
   * Prior conversation history (from earlier LLM/sub-harness steps and turns)
   * used to seed a fresh session so the agent has full context of the
   * conversation so far. Empty for the very first step of a run.
   */
  history?: ReadonlyArray<Item>;
  /** The workspace surface for this run. */
  ctx: SubHarnessRunContext;
  /** Resume a previously stopped/detached session. */
  resumeFrom?: SubHarnessResumeState;
  /** Continue a turn previously frozen via {@link SubHarnessSession.doSuspendTurn}. */
  continueFrom?: SubHarnessContinueState;
  signal?: AbortSignal;
}

/** @public Options for a single agentic turn. */
export interface SubHarnessPromptTurnOptions {
  /** Fresh turn input only — the session owns conversation history. */
  prompt: string;
  /** Sink for stream events produced during the turn. */
  emit: (part: SubHarnessStreamPart) => void;
  signal?: AbortSignal;
}

/** @public Options for continuing a turn frozen mid-flight. */
export interface SubHarnessContinueTurnOptions {
  emit: (part: SubHarnessStreamPart) => void;
  signal?: AbortSignal;
}

/**
 * Result of a completed agentic turn. The interpreter appends `items` to the
 * item log, charges `usage`/`cost`, and returns `text` (or parses it through
 * the step's output schema).
 * @public
 */
export interface SubHarnessTurnResult {
  /** Noetic Items produced this turn (assistant message, tool calls/results). */
  items: Item[];
  /** Final assistant text of the turn. */
  text: string;
  usage?: TokenUsage;
  cost?: number;
  finishReason?: SubHarnessFinishReason;
  /** Adapter-specific metadata (peer to provider metadata, not a subtype). */
  harnessMetadata?: Record<string, unknown>;
}

//#endregion

//#region Built-in tool vocabulary

/**
 * Describes a tool the underlying agent executes natively, mapped to a shared
 * `commonName` so consumers can recognise "the same kind of tool" across
 * harnesses (Claude's `Bash`, Codex's `shell`, pi's `bash` → `shell`).
 * @public
 */
export interface SubHarnessBuiltinTool {
  /** The agent's native tool name. */
  readonly nativeName: string;
  /** Shared cross-harness name, when one exists. */
  readonly commonName?: string;
  readonly description?: string;
}

//#endregion

//#region The contract

/**
 * A live harness session: one workspace + one conversation history + one
 * running runtime, kept across turns by the interpreter.
 * @public
 */
export interface SubHarnessSession {
  readonly sessionId: string;
  /** True when this session was resumed rather than freshly started. */
  readonly isResume: boolean;
  /** The model the session resolved to, when the runtime reports it. */
  readonly modelId?: string;
  /** Run one agentic turn to completion. */
  doPromptTurn(opts: SubHarnessPromptTurnOptions): Promise<SubHarnessTurnResult>;
  /** Continue a turn previously frozen via {@link doSuspendTurn}. */
  doContinueTurn?(opts: SubHarnessContinueTurnOptions): Promise<SubHarnessTurnResult>;
  /** Freeze the current turn at a precise event cursor; runtime stays alive. */
  doSuspendTurn?(): Promise<SubHarnessContinueState>;
  /** Manually compact conversation history. Throws {@link SubHarnessCapabilityError} if unsupported. */
  doCompact?(customInstructions?: string): Promise<void>;
  /** Park the session between turns; runtime stays alive. */
  doDetach?(): Promise<SubHarnessResumeState>;
  /** Persist state and stop the runtime. */
  doStop(): Promise<SubHarnessResumeState>;
  /** Stop the runtime with no resume state. */
  doDestroy?(): Promise<void>;
}

/**
 * A coding-agent harness. Each `@noetic-tools/sub-harness-*` package exports a
 * factory returning one of these (e.g. `claudeCode({ model })`).
 * @public
 */
export interface SubHarness<TSettings = SubHarnessSettings> {
  /** Spec tag for forward-compatibility. */
  readonly specificationVersion: 'harness-v1';
  /** Stable identifier, equal to the step kind it backs (e.g. `claude-code`). */
  readonly harnessId: SubHarnessKind;
  /** Tools the underlying agent executes natively. */
  readonly builtinTools?: ReadonlyArray<SubHarnessBuiltinTool>;
  /** Validates `resumeFrom`/`continueFrom` payloads, when the adapter persists them. */
  readonly lifecycleStateSchema?: z.ZodType;
  /** Start (or resume/continue) a session. */
  doStart(opts: SubHarnessStartOptions<TSettings>): Promise<SubHarnessSession>;
}

//#endregion
