import type { ItemSchemaRegistry } from '../schemas/item';
import type { Channel } from './channel';
import type { StepMeta, TokenUsage } from './common';
import type { ContextHarness } from './context-harness';
import type { ContextData, ContextLayer } from './context-layer';
import type { ItemLog } from './context-parts/item-log';
import type { LastLayerUsage } from './context-parts/layer-usage';
import type { FsAdapter } from './fs-adapter';
import type { Span } from './observability';
import type { ShellAdapter } from './shell-adapter';
import type { SubprocessAdapter } from './subprocess-adapter';
import type { Tool } from './tool';

/**
 * @public Mutable working-directory state shared among the tools attached to a
 * single Context. The reference is fixed for the Context's lifetime; mutate
 * via `setToolCwd` so that all tools observe the new value at execution time.
 *
 * Spawned children receive a snapshot — child mutations do not affect the parent.
 */
export interface CwdState {
  cwd: string;
  previousCwd?: string;
}

/**
 * @public Caller-supplied wiring forwarded to the `createContext` call that
 * `harness.restore()` makes internally.
 *
 * A snapshot recovers the item log, layer state, cwd, and identity — it cannot
 * recover the live objects a host attached when it built the original context
 * (event broadcasters, queues, per-host state). Pass the same wiring here that
 * was passed to `createContext` originally, or the resumed run silently loses
 * it.
 *
 * Snapshot-owned fields (`items`, `threadId`, `resourceId`, `cwdInit`) are
 * deliberately absent: they always come from the persisted snapshot, so
 * accepting them here would only offer a value that gets ignored.
 *
 * Anything a host attaches *after* construction — `Object.assign`ed fields,
 * abort registration — stays the host's responsibility and can be applied to
 * the context `restore()` returns.
 */
export interface RestoreContextOptions {
  /** Live parent context, when the restored execution hangs under one. */
  parent?: Context;
  /** Charge the restored context's usage to `parent`, same as `createContext({ rollUpUsage })`. Default `true`. */
  rollUpUsage?: boolean;
  /** Opaque per-execution state, same as `createContext({ state })`. */
  state?: unknown;
  /** Context layers for the restored context. Defaults to the harness's configured layers. */
  contextLayers?: ContextLayer[];
}

/** @public Execution context threaded through every step, carrying state, metrics, and channels. */
export interface Context<TContext = ContextData, TState = unknown> {
  readonly id: string;
  readonly stepCount: number;
  readonly tokens: TokenUsage;
  readonly elapsed: number;
  /** USD the work run on this context cost, including spend restored from a checkpoint. */
  readonly cost: number;
  /**
   * USD this context's calls actually paid during this attempt. Replayed steps and
   * rounds add nothing, and a restored context starts at 0, so `cost - billedCost` is
   * what replay saved.
   */
  readonly billedCost: number;
  /**
   * USD held for paid calls of this execution that were cut off and have no settled
   * bill yet: each at its ceiling until reconciled. A bound, never part of `cost` or
   * `billedCost`. Nonzero only on a root context.
   */
  readonly heldCost: number;
  state: TState;
  readonly parent: Context<ContextData> | null;
  /**
   * Where this context's token/cost usage is also charged. Every charge
   * recorded here is added to this context and then to each ancestor along
   * this chain, so `tokens` / `cost` cover this context plus every descendant,
   * live — whether the descendant succeeds, fails, or is abandoned.
   *
   * Equals `parent` unless the context was created with `rollUpUsage: false`,
   * in which case it is `null` and the context keeps its spend to itself. When
   * absent (a hand-rolled `Context` implementation), `parent` is used.
   */
  readonly usageParent?: Context<ContextData> | null;
  readonly depth: number;
  readonly span: Span;
  readonly threadId: string;
  readonly resourceId?: string;
  readonly itemLog: ItemLog;
  readonly lastStepMeta: StepMeta | null;
  /** Per-layer breakdown of the context window as of the most recent callModel. Undefined until the first LLM call completes. */
  readonly lastLayerUsage?: LastLayerUsage;
  readonly harness: ContextHarness;
  /** Filesystem adapter for virtual or real filesystem access. */
  readonly fs: FsAdapter;
  /** Shell adapter for virtual or real shell command execution. */
  readonly shell: ShellAdapter;
  /** Subprocess adapter for virtual, same-process, or host process execution. */
  readonly subprocess: SubprocessAdapter;
  /**
   * Mutable cwd state shared with the tools bound to this context. Tools
   * resolve relative paths from `cwdState.cwd` at execution time so that an
   * agent `cd` propagates to subsequent tool calls.
   */
  readonly cwdState: CwdState;
  readonly layers?: ContextLayer[];
  /** Layer provides keyed by layer ID. Access data/functions via `ctx.context['layerId'].prop`. */
  readonly context: TContext;
  /** Unified tool set collected from all LLM steps in the step tree before execution. */
  readonly unifiedTools?: ReadonlyArray<Tool>;
  /** Runtime item schema registry active for this context. */
  readonly itemSchemas?: ItemSchemaRegistry;
  /**
   * Receive a value from a channel. Waits up to `opts.timeout` ms (default
   * 30s) before rejecting with `channel_timeout`; `timeout: 0` waits with no
   * timeout in every mode and records an `unbounded_wait` channel warning.
   * Aborting the context rejects the wait with `cancelled`.
   *
   * @throws `NoeticConfigError` with code `INVALID_CHANNEL_TIMEOUT` (as a
   * rejection) when `opts.timeout` is negative.
   */
  recv<T>(
    channel: Channel<T>,
    opts?: {
      timeout?: number;
    },
  ): Promise<T>;
  /**
   * Send a value into a channel. Resolves immediately for value/topic
   * channels and for queue channels below capacity. When a queue channel is
   * at capacity the returned promise parks until a consumer dequeues an item
   * (back-pressure): after the default 30s timeout it rejects with
   * `channel_timeout`, and aborting the context rejects it with `cancelled`.
   */
  send<T>(channel: Channel<T>, value: NoInfer<T>): Promise<void>;
  tryRecv<T>(channel: Channel<T>): T | null;
  checkpoint(): Promise<void>;
  complete<T>(value: T): void;
  readonly completed: boolean;
  readonly completionValue: unknown;
  readonly aborted: boolean;
  readonly abortReason?: string;
  /**
   * Cancel this context and everything running beneath it. The first call wins
   * (later calls are no-ops, so `abortReason` is stable), and it cascades
   * *down* the execution tree: every live fork path and spawn child is aborted
   * too. It never travels up — aborting a child leaves the parent running.
   *
   * Aborting rejects operations blocked on the context (channel `recv` waiters,
   * parked back-pressure senders) with `cancelled`, cuts short the in-flight
   * model call or ACP agent turn, and makes the next step boundary throw
   * `cancelled`. Context-layer teardown is NOT run — use
   * `harness.cancel(ctx, reason)` for that.
   */
  abort(reason?: string): void;
}
