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
  readonly cost: number;
  state: TState;
  readonly parent: Context<ContextData> | null;
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
  send<T>(channel: Channel<T>, value: T): Promise<void>;
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
   * model call or sub-harness turn, and makes the next step boundary throw
   * `cancelled`. Context-layer teardown is NOT run — use
   * `harness.cancel(ctx, reason)` for that.
   */
  abort(reason?: string): void;
}
