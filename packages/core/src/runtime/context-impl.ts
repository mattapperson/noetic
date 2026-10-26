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
import { hashStepInput } from './durable/step-ledger';
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
 * Id of the root execution `ctx` runs under — the id `run()` opens and
 * closes channel scopes with (spec 06).
 */
export function rootIdOf(ctx: Context): string {
  let node: Context = ctx;
  while (node.parent) {
    node = node.parent;
  }
  return node.id;
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
  billedCost = 0;
  state: unknown;
  readonly parent: Context<ContextData> | null;
  readonly usageParent: Context<ContextData> | null;
  readonly depth: number;
  readonly span: Span;
  readonly threadId: string;
  readonly resourceId?: string;
  readonly itemLog: ItemLog;
  /** The same log, typed for `rebase`. */
  private readonly log: ItemLogImpl;
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
   * Steps in flight on this context, in dispatch order. `enterStep` adds a frame and
   * `leaveStep` removes that same frame, so concurrent dispatches can settle in any
   * order without disturbing each other. The checkpoint writer serialises this set as
   * the execution frontier.
   * @internal
   */
  private readonly _inFlight = new Set<FrontierFrame>();

  /**
   * Execution path of the step whose lane this is. On the context itself it is the
   * prefix its steps hang under: empty on a root context, the parent's path plus a
   * discriminator on an inParallel/spawn child, so a path stays unique across the whole
   * step tree. A lane (see `enterStep`) reads its own step's path here instead.
   * @internal
   */
  private readonly _path: string;

  /**
   * Dispatch counts per `<parent path>/<step id>`, so a loop body re-entered on each
   * iteration gets `#0`, `#1`, … instead of colliding on one key. Shared by every lane.
   * @internal
   */
  private readonly _occurrences = new Map<string, number>();

  /**
   * Completion ledger for the execution this context belongs to. Shared by reference
   * with inParallel/spawn children — one execution, one ledger.
   * @internal
   */
  readonly ledger?: StepLedger;

  /**
   * The dispatch this view belongs to. Undefined on the context itself; a lane (see
   * `enterStep`) reads its own here.
   * @internal
   */
  private readonly _lane?: Lane;

  /**
   * The item log and dispatch counts as they stood when the outermost run on this
   * context began. A checkpoint persists these rather than the live values, because a
   * resumed run starts that run over: its recorded steps replay and re-append their
   * items, so the log must not already hold them. Unset between runs, and kept after a
   * run that failed — that run is what a resume repeats.
   * @internal
   */
  private _baseline?: RunBaseline;

  constructor(opts: {
    harness: AgentHarnessContract;
    parent?: Context;
    /** Charge this context's usage to `parent` as it is spent. Default `true`. */
    rollUpUsage?: boolean;
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
    this.usageParent = opts.rollUpUsage === false ? null : this.parent;
    this.depth = this.parent ? this.parent.depth + 1 : 0;
    this.span = opts.span ?? new NoopSpan();
    this.threadId = opts.threadId ?? crypto.randomUUID();
    this.resourceId = opts.resourceId;
    this.channelStore = opts.channelStore;
    this._checkpointFn = opts.checkpointFn;
    this._path = opts.pathPrefix ?? '';
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
    this.log = log;

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
    this.channelStore.claim(ch, rootIdOf(this));
    return this.channelStore.recv(ch, opts?.timeout, this._abortController.signal);
  }

  send<T>(ch: Channel<T>, value: NoInfer<T>): Promise<void> {
    if (!this.channelStore) {
      return Promise.reject(new Error('No channel store configured'));
    }
    // Internal sender: back-pressured on full queue channels (default 30s →
    // channel_timeout); aborting this context rejects a parked send with
    // 'cancelled' via the shared abort signal.
    this.channelStore.claim(ch, rootIdOf(this));
    return this.channelStore.send(ch, value, {
      signal: this._abortController.signal,
    });
  }

  tryRecv<T>(ch: Channel<T>): T | null {
    if (!this.channelStore) {
      throw new Error('No channel store configured');
    }
    this.channelStore.claim(ch, rootIdOf(this));
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
   * Register `frame` as in flight and return the lane its step runs on: a view of
   * this context that shares everything except its execution path and the record of
   * items appended through it. `execute()` hands the lane to the step, so steps the
   * step dispatches hang under its path no matter how other dispatches on this context
   * interleave. The occurrence ordinal is taken here, at dispatch, never at settle.
   */
  enterStep(frame: FrontierFrame): ContextImpl {
    const key = `${this._path}/${frame.stepId}`;
    const occurrence = this._occurrences.get(key) ?? 0;
    this._occurrences.set(key, occurrence + 1);
    this._inFlight.add(frame);
    return laneOf(this, {
      path: `${key}#${occurrence}`,
      key,
      occurrence,
      stepId: frame.stepId,
      inputHash: this.ledger ? hashStepInput(frame.input) : undefined,
      recorded: true,
      appended: new AppendRecord(this._lane?.appended),
    });
  }

  /**
   * @internal
   * Mark this lane's step as kept out of the ledger (`durable: false`, `schedule`, a
   * failed `replayKey`), so nothing running inside it records under its identity.
   */
  skipLedger(): void {
    if (this._lane) {
      this._lane.recorded = false;
    }
  }

  /**
   * @internal
   * The dispatch this lane belongs to, or undefined on the context itself and on a
   * lane kept out of the ledger. Lets code running inside a step (the model loop's
   * rounds) record under the step's identity.
   */
  currentDispatch():
    | {
        path: string;
        stepId: string;
        inputHash: string | undefined;
      }
    | undefined {
    const lane = this._lane;
    return lane?.recorded
      ? {
          path: lane.path,
          stepId: lane.stepId,
          inputHash: lane.inputHash,
        }
      : undefined;
  }

  /**
   * @internal
   * The execution path of the step this lane belongs to — the ledger key identifying
   * this exact dispatch. Stable across a replay given the same control flow, which is
   * what lets a resumed run line recorded outputs up with the steps that produced them.
   */
  currentPath(): string {
    return this._path;
  }

  /**
   * @internal
   * Items appended to the item log through this lane, including by steps it
   * dispatched on the same context. Empty on the context itself.
   */
  appendedItems(): Item[] {
    return [
      ...(this._lane?.appended.items ?? []),
    ];
  }

  /**
   * @internal
   * Drop `frame` from the in-flight set. Called when its step resolves, success or
   * failure.
   */
  leaveStep(frame: FrontierFrame): void {
    this._inFlight.delete(frame);
  }

  /**
   * @internal
   * Give back this lane's ordinal after its step failed, so a retry runs at the same
   * path. A resumed run never sees the failed attempt — nothing records a failure — so
   * without this a retry would take the next ordinal and every later dispatch would sit
   * one position past where the resume looks for it. Only the latest dispatch of a key
   * can give its ordinal back; once a later one has taken the next, the ordinal stays.
   */
  releaseDispatch(): void {
    const lane = this._lane;
    if (!lane || this._occurrences.get(lane.key) !== lane.occurrence + 1) {
      return;
    }
    this._occurrences.set(lane.key, lane.occurrence);
    for (const key of [
      ...this._occurrences.keys(),
    ]) {
      if (key.startsWith(`${lane.path}/`)) {
        this._occurrences.delete(key);
      }
    }
  }

  /**
   * @internal
   * Mark the start of the outermost run on this context. See `_baseline`.
   */
  beginRun(): void {
    this._baseline = {
      items: [
        ...this.itemLog.items,
      ],
      occurrences: Object.fromEntries(this._occurrences),
    };
  }

  /**
   * @internal
   * Mark a run as finished, so checkpoints record the live log and counts again.
   */
  endRun(): void {
    this._baseline = undefined;
  }

  /**
   * @internal
   * What a checkpoint persists for the item log and dispatch counts — see `_baseline`.
   */
  runBaseline(): RunBaseline {
    return (
      this._baseline ?? {
        items: [
          ...this.itemLog.items,
        ],
        occurrences: Object.fromEntries(this._occurrences),
      }
    );
  }

  /**
   * @internal
   * Whether a run on this context began and never finished — it failed, or is in
   * flight. A run starting now repeats it.
   */
  hasUnfinishedRun(): boolean {
    return this._baseline !== undefined;
  }

  /**
   * @internal
   * Stand the context back at a stored run baseline: the item log and dispatch counts
   * a checkpoint recorded. For a run retried in place, which must see what a resume on
   * a new harness would — not the items and counts its failed attempt left in memory.
   */
  rebase(baseline: RunBaseline): void {
    this.log.replace(baseline.items);
    this._occurrences.clear();
    this.restoreOccurrences(baseline.occurrences);
  }

  /**
   * @internal
   * Seed the dispatch counts a restored run starts from, so a resumed context numbers
   * its dispatches where the recorded run did rather than from zero.
   */
  restoreOccurrences(occurrences: Record<string, number>): void {
    for (const [key, count] of Object.entries(occurrences)) {
      this._occurrences.set(key, count);
    }
  }

  /**
   * @internal
   * Return a defensive copy of the current frontier. Consumed by the
   * checkpoint writer — see `AgentHarness.checkpoint`.
   */
  serialiseFrontier(): FrontierFrame[] {
    return [
      ...this._inFlight,
    ].map((frame) => ({
      stepId: frame.stepId,
      input: frame.input,
      state: frame.state,
    }));
  }
}

//#region Lanes

/** @internal Item log and dispatch counts at the start of a run — see `ContextImpl._baseline`. */
export interface RunBaseline {
  items: Item[];
  occurrences: Record<string, number>;
}

/** One dispatch's view data. */
interface Lane {
  /** Execution path: `<parent path>/<step id>#<ordinal>`. */
  path: string;
  /** `<parent path>/<step id>` — the occurrence counter this dispatch took from. */
  key: string;
  occurrence: number;
  stepId: string;
  /** `hashStepInput` of the step's input, taken only when the context has a ledger. */
  inputHash: string | undefined;
  /** False once the interpreter keeps this step out of the ledger — see `skipLedger`. */
  recorded: boolean;
  appended: AppendRecord;
}

/**
 * Items appended through one lane. Each record also feeds its parent lane's, so a
 * composite step's record holds everything appended beneath it on the same context.
 */
class AppendRecord {
  readonly items: Item[] = [];

  constructor(private readonly parent?: AppendRecord) {}

  add(item: Item): void {
    this.items.push(item);
    this.parent?.add(item);
  }
}

/** The context each lane views, so `laneOf` never stacks a proxy on a proxy. */
const laneTargets = new WeakMap<ContextImpl, ContextImpl>();

/**
 * A view of `ctx` that reads `lane` as its dispatch and forwards every other read and
 * write to the context itself, so state, usage, abort, and the in-flight set stay
 * shared. Its item log appends to the shared log and notes each item in the lane's
 * record. A Proxy rather than a subclass: steps assign `ctx.state` and friends
 * directly, and a copy would keep those writes to itself.
 */
function laneOf(ctx: ContextImpl, lane: Lane): ContextImpl {
  const target = laneTargets.get(ctx) ?? ctx;
  const itemLog: ItemLog = {
    get items() {
      return target.itemLog.items;
    },
    append(item: Item) {
      target.itemLog.append(item);
      const items = target.itemLog.items;
      lane.appended.add(items[items.length - 1]);
    },
  };
  const view = new Proxy(target, {
    get(base, prop, receiver) {
      if (prop === '_path') {
        return lane.path;
      }
      if (prop === '_lane') {
        return lane;
      }
      if (prop === 'itemLog') {
        return itemLog;
      }
      return Reflect.get(base, prop, receiver);
    },
    set(base, prop, value) {
      return Reflect.set(base, prop, value);
    },
  });
  laneTargets.set(view, target);
  return view;
}

/**
 * @internal
 * The context a lane views, or `ctx` itself when it is not a lane. For per-execution
 * caches keyed by context identity, which every lane of one context must share.
 */
export function laneBase(ctx: Context<ContextData>): Context<ContextData> {
  return ctx instanceof ContextImpl ? (laneTargets.get(ctx) ?? ctx) : ctx;
}

//#endregion
