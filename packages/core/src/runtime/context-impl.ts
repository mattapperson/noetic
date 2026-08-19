import type {
  AgentHarnessContract,
  Channel,
  ChannelStore,
  Context,
  ContextData,
  ContextLayer,
  CwdState,
  EventBroadcaster,
  FrontierFrame,
  FsAdapter,
  Item,
  ItemLog,
  ItemSchemaRegistry,
  LastLayerUsage,
  Span,
  StepMeta,
  TokenUsage,
  Tool,
} from './context-deps';
import { buildContextData, defaultItemSchemaRegistry } from './context-deps';
import type { StepLedger } from './durable/step-ledger';
import { ItemLogImpl } from './item-log-impl';

const EMPTY_CONTEXT: ContextData = Object.freeze({});

class NoopSpan implements Span {
  readonly traceId = crypto.randomUUID();
  readonly spanId = crypto.randomUUID();
  readonly parentSpanId = null;
  setAttribute(_key: string, _value: string | number | boolean): void {}
  addEvent(_name: string, _attributes?: Record<string, string | number | boolean>): void {}
  end(): void {}
}

/**
 * @internal
 * The cancellation tree rooted at `ctx`, in pre-order (a parent before its
 * children). Reverse it to walk deepest-first. Only framework contexts track
 * children, so a foreign `Context` implementation yields just itself.
 */
export function collectContextTree(ctx: Context): Context[] {
  const tree: Context[] = [
    ctx,
  ];
  if (!(ctx instanceof ContextImpl)) {
    return tree;
  }
  for (const child of ctx.children) {
    tree.push(...collectContextTree(child));
  }
  return tree;
}

export class ContextImpl implements Context<ContextData> {
  readonly id: string;
  stepCount = 0;
  tokens: TokenUsage = {
    input: 0,
    output: 0,
    total: 0,
  };
  cost = 0;
  state: unknown;
  readonly parent: Context<ContextData> | null;
  readonly depth: number;
  readonly span: Span;
  readonly threadId: string;
  readonly resourceId?: string;
  readonly itemLog: ItemLog;
  lastStepMeta: StepMeta | null = null;
  lastLayerUsage: LastLayerUsage | undefined = undefined;
  readonly harness: AgentHarnessContract;
  readonly layers?: ContextLayer[];
  unifiedTools?: ReadonlyArray<Tool>;
  readonly itemSchemas?: ItemSchemaRegistry;
  readonly cwdState: CwdState;

  /** @internal Event broadcaster for streaming — not part of public Context interface. */
  readonly _broadcaster?: EventBroadcaster;

  private readonly _createdAt: number;
  /**
   * Shared channel store for cross-context communication. Inherited by
   * `inParallel` / `spawn` children so channels published by a sibling are visible
   * to peers — see `executeInParallel` and `executeSpawn` in `interpreter/execute-action.ts`
   * and `interpreter/execute-control.ts`.
   * @internal
   */
  readonly channelStore?: ChannelStore;
  private _checkpointFn?: (ctx: Context) => Promise<void>;
  private _completionValue?: unknown;
  private _completed = false;
  private _aborted = false;
  private _abortReason?: string;
  /**
   * Per-context abort fan-out. `abort()` fires it so operations blocked on
   * this context (channel `recv` waiters, parked back-pressure senders)
   * reject promptly with `{ kind: 'cancelled' }` instead of hanging until
   * their timeout (spec 09, Cancellation item 2). Each inParallel/spawn child
   * constructs its own ContextImpl and therefore its own controller —
   * aborting a child never rejects the parent's waiters, while aborting a
   * parent DOES cascade down to every live child (see `_children`).
   */
  private readonly _abortController = new AbortController();
  /**
   * Live child contexts (inParallel paths, spawn children) registered for the abort
   * cascade. A child adds itself at construction and removes itself via
   * `detachFromParent()` when its execution settles, so a long-lived parent
   * driving a loop of spawns does not accumulate finished children.
   * @internal
   */
  private readonly _children = new Set<ContextImpl>();
  private _contextData?: ContextData;
  /**
   * Stack of steps currently in flight on this context, most-recent last.
   * Pushed by `enterStep` at the top of `execute()` and popped by
   * `leaveStep` when the step resolves (success or failure). The harness'
   * checkpoint writer serialises this stack as the execution frontier so
   * a restart can identify which step the context was paused inside.
   * @internal
   */
  private readonly _frontier: FrontierFrame[] = [];

  /**
   * Path segment for each in-flight frame, parallel to `_frontier`. Kept separate so
   * `serialiseFrontier()` keeps emitting the published `FrontierFrame` shape.
   * @internal
   */
  private readonly _segments: string[] = [];

  /**
   * Path this context's steps hang under. Empty on a root context; an inParallel/spawn child
   * inherits its parent's current path plus a discriminator, so a path key stays unique
   * across the whole step tree rather than restarting per child context.
   * @internal
   */
  private readonly _pathPrefix: string;

  /**
   * Dispatch counts per `<parent path>/<step id>`, so a loop body re-entered on each
   * iteration gets `#0`, `#1`, … instead of colliding on one key.
   * @internal
   */
  private readonly _occurrences = new Map<string, number>();

  /**
   * Completion ledger for the execution this context belongs to. Shared by reference
   * with inParallel/spawn children — one execution, one ledger.
   * @internal
   */
  readonly ledger?: StepLedger;

  constructor(opts: {
    harness: AgentHarnessContract;
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    span?: Span;
    channelStore?: ChannelStore;
    checkpointFn?: (ctx: Context) => Promise<void>;
    /** Path this context's steps hang under (inParallel/spawn children inherit one). */
    pathPrefix?: string;
    /** The execution's completion ledger, shared with children by reference. */
    ledger?: StepLedger;
    layers?: ContextLayer[];
    unifiedTools?: ReadonlyArray<Tool>;
    itemSchemas?: ItemSchemaRegistry;
    cwdState?: CwdState;
    _broadcaster?: EventBroadcaster;
    /**
     * Pre-chosen context id. When set, the ContextImpl adopts this id instead
     * of generating a fresh UUID. Used by `executeSpawn` so the child's
     * `ctx.id` matches the `executionId` keyed into the layer-state store —
     * otherwise writes via `ctx.context[layerId].state` land on one id while
     * spawn's `onReturn` reads from another, silently losing the update.
     */
    id?: string;
  }) {
    this.id = opts.id ?? crypto.randomUUID();
    this._createdAt = Date.now();
    this.harness = opts.harness;
    this.state = opts.state ?? {};
    this.parent = opts.parent ?? null;
    this.depth = this.parent ? this.parent.depth + 1 : 0;
    this.span = opts.span ?? new NoopSpan();
    this.threadId = opts.threadId ?? crypto.randomUUID();
    this.resourceId = opts.resourceId;
    this.channelStore = opts.channelStore;
    this._checkpointFn = opts.checkpointFn;
    this._pathPrefix = opts.pathPrefix ?? '';
    this.ledger = opts.ledger;
    this.layers = opts.layers;
    this.unifiedTools = opts.unifiedTools;
    this.itemSchemas = opts.itemSchemas ?? defaultItemSchemaRegistry;
    this.cwdState = opts.cwdState ?? {
      cwd: process.cwd(),
    };
    this._broadcaster = opts._broadcaster;

    const log = new ItemLogImpl(this.itemSchemas);
    if (opts.items) {
      for (const item of opts.items) {
        log.append(item);
      }
    }
    this.itemLog = log;

    // Join the parent's abort cascade last, so the child is fully constructed
    // before an already-aborted parent aborts it.
    if (this.parent instanceof ContextImpl) {
      this.parent.adoptChild(this);
    }
  }

  /**
   * @internal
   * Register `child` for the abort cascade. A child constructed under an
   * already-aborted parent is aborted immediately — otherwise a spawn issued
   * in the window between `abort()` and the interpreter noticing would run a
   * whole sub-agent that nothing can stop.
   */
  private adoptChild(child: ContextImpl): void {
    if (this._aborted) {
      child.abort(this._abortReason ?? 'parent context aborted');
      return;
    }
    this._children.add(child);
  }

  /**
   * @internal
   * Leave the parent's abort cascade. Called by the interpreter when a spawn
   * child or inParallel path settles — a finished child has nothing left to cancel,
   * and holding it would leak for the remaining life of the parent.
   */
  detachFromParent(): void {
    if (this.parent instanceof ContextImpl) {
      this.parent._children.delete(this);
    }
  }

  /**
   * @internal
   * Live child contexts, in registration order. Consumed by
   * `AgentHarness.cancel` to walk the execution tree depth-first.
   */
  get children(): ReadonlyArray<ContextImpl> {
    return [
      ...this._children,
    ];
  }

  get elapsed(): number {
    return Date.now() - this._createdAt;
  }

  get aborted(): boolean {
    return this._aborted;
  }

  get fs(): FsAdapter {
    return this.harness.fs;
  }

  get shell(): AgentHarnessContract['shell'] {
    return this.harness.shell;
  }

  get subprocess(): AgentHarnessContract['subprocess'] {
    return this.harness.subprocess;
  }

  get context(): ContextData {
    if (!this._contextData) {
      this._contextData = this.layers ? buildContextData(this.layers, this) : EMPTY_CONTEXT;
    }
    return this._contextData;
  }

  recv<T>(
    ch: Channel<T>,
    opts?: {
      timeout?: number;
    },
  ): Promise<T> {
    if (!this.channelStore) {
      return Promise.reject(new Error('No channel store configured'));
    }
    return this.channelStore.recv(ch, opts?.timeout, this._abortController.signal);
  }

  send<T>(ch: Channel<T>, value: T): Promise<void> {
    if (!this.channelStore) {
      return Promise.reject(new Error('No channel store configured'));
    }
    // Internal sender: back-pressured on full queue channels (default 30s →
    // channel_timeout); aborting this context rejects a parked send with
    // 'cancelled' via the shared abort signal.
    return this.channelStore.send(ch, value, {
      signal: this._abortController.signal,
    });
  }

  tryRecv<T>(ch: Channel<T>): T | null {
    if (!this.channelStore) {
      throw new Error('No channel store configured');
    }
    return this.channelStore.tryRecv(ch);
  }

  async checkpoint(): Promise<void> {
    if (this._checkpointFn) {
      await this._checkpointFn(this);
    }
  }

  complete<T>(value: T): void {
    this._completed = true;
    this._completionValue = value;
  }

  get completed(): boolean {
    return this._completed;
  }

  get completionValue(): unknown {
    return this._completionValue;
  }

  get abortReason(): string | undefined {
    return this._abortReason;
  }

  abort(reason?: string): void {
    if (this._aborted) {
      // Idempotent (spec 09): the first abort owns the reason, and the signal
      // has already fired — re-firing it would be a no-op anyway.
      return;
    }
    this._aborted = true;
    this._abortReason = reason;
    // Reject everything blocked on this context (channel recv waiters,
    // parked back-pressure senders) with { kind: 'cancelled' }.
    this._abortController.abort(reason ?? 'context aborted');
    // Cascade to live children (inParallel paths, spawn children). The registry is
    // cleared first so a child's own `detachFromParent()` during its unwind
    // cannot mutate the set we are iterating.
    const children = [
      ...this._children,
    ];
    this._children.clear();
    for (const child of children) {
      child.abort(reason ?? 'parent context aborted');
    }
  }

  /**
   * @internal
   * Abort signal scoped to this context. Channel operations register on it
   * so `abort()` rejects them promptly. Not part of the public Context
   * interface.
   */
  get abortSignal(): AbortSignal {
    return this._abortController.signal;
  }

  /**
   * @internal
   * Push a frame onto the execution frontier. Called by `execute()` at the
   * top of every step dispatch so that the frontier reflects exactly the
   * stack of steps currently in-flight on this context.
   */
  enterStep(frame: FrontierFrame): void {
    const parent = this.currentPath();
    const key = `${parent}/${frame.stepId}`;
    const occurrence = this._occurrences.get(key) ?? 0;
    this._occurrences.set(key, occurrence + 1);
    this._segments.push(`/${frame.stepId}#${occurrence}`);
    this._frontier.push(frame);
  }

  /**
   * @internal
   * The execution path of the step currently on top of the frontier — the ledger key
   * identifying this exact dispatch. Stable across a replay given the same control
   * flow, which is what lets a resumed run line recorded outputs up with the steps
   * that produced them.
   */
  currentPath(): string {
    return this._pathPrefix + this._segments.join('');
  }

  /**
   * @internal
   * Pop the top frame. Called when a step resolves (success or failure)
   * so that the frontier unwinds cleanly. The value of `expectedStepId`
   * is used as a consistency check — if it does not match the top frame
   * the pop is still performed, but a best-effort warning is surfaced to
   * stderr rather than swallowed silently.
   */
  leaveStep(expectedStepId: string): void {
    const top = this._frontier[this._frontier.length - 1];
    if (top && top.stepId !== expectedStepId) {
      // A mismatch indicates bookkeeping drift. We unwind best-effort and
      // let the caller observe via `serialiseFrontier()` if needed.
      console.warn(
        `ContextImpl.leaveStep: expected "${expectedStepId}" on top of frontier but saw "${top.stepId}".`,
      );
    }
    this._frontier.pop();
    this._segments.pop();
  }

  /**
   * @internal
   * Return a defensive copy of the current frontier. Consumed by the
   * checkpoint writer — see `AgentHarness.checkpoint`.
   */
  serialiseFrontier(): FrontierFrame[] {
    return this._frontier.map((frame) => ({
      stepId: frame.stepId,
      input: frame.input,
      state: frame.state,
    }));
  }
}
