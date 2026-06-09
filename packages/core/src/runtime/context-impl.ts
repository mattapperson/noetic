import type {
  AgentHarnessContract,
  Channel,
  ChannelStore,
  Context,
  ContextMemory,
  CwdState,
  EventBroadcaster,
  FrontierFrame,
  FsAdapter,
  Item,
  ItemLog,
  ItemSchemaRegistry,
  LastLayerUsage,
  MemoryLayer,
  Span,
  StepMeta,
  TokenUsage,
  Tool,
} from './context-deps';
import { buildContextMemory, defaultItemSchemaRegistry } from './context-deps';
import { ItemLogImpl } from './item-log-impl';

const EMPTY_MEMORY: ContextMemory = Object.freeze({});

class NoopSpan implements Span {
  readonly traceId = crypto.randomUUID();
  readonly spanId = crypto.randomUUID();
  readonly parentSpanId = null;
  setAttribute(_key: string, _value: string | number | boolean): void {}
  addEvent(_name: string, _attributes?: Record<string, string | number | boolean>): void {}
  end(): void {}
}

export class ContextImpl implements Context<ContextMemory> {
  readonly id: string;
  stepCount = 0;
  tokens: TokenUsage = {
    input: 0,
    output: 0,
    total: 0,
  };
  cost = 0;
  state: unknown;
  readonly parent: Context<ContextMemory> | null;
  readonly depth: number;
  readonly span: Span;
  readonly threadId: string;
  readonly resourceId?: string;
  readonly itemLog: ItemLog;
  lastStepMeta: StepMeta | null = null;
  lastLayerUsage: LastLayerUsage | undefined = undefined;
  readonly harness: AgentHarnessContract;
  readonly layers?: MemoryLayer[];
  unifiedTools?: ReadonlyArray<Tool>;
  readonly itemSchemas?: ItemSchemaRegistry;
  readonly cwdState: CwdState;

  /** @internal Event broadcaster for streaming — not part of public Context interface. */
  readonly _broadcaster?: EventBroadcaster;

  private readonly _createdAt: number;
  /**
   * Shared channel store for cross-context communication. Inherited by
   * `fork` / `spawn` children so channels published by a sibling are visible
   * to peers — see `executeFork` and `executeSpawn` in `interpreter/execute-action.ts`
   * and `interpreter/execute-control.ts`.
   * @internal
   */
  readonly channelStore?: ChannelStore;
  private _checkpointFn?: () => Promise<void>;
  private _completionValue?: unknown;
  private _completed = false;
  private _aborted = false;
  private _abortReason?: string;
  private _memory?: ContextMemory;
  /**
   * Stack of steps currently in flight on this context, most-recent last.
   * Pushed by `enterStep` at the top of `execute()` and popped by
   * `leaveStep` when the step resolves (success or failure). The harness'
   * checkpoint writer serialises this stack as the execution frontier so
   * a restart can identify which step the context was paused inside.
   * @internal
   */
  private readonly _frontier: FrontierFrame[] = [];

  constructor(opts: {
    harness: AgentHarnessContract;
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    span?: Span;
    channelStore?: ChannelStore;
    checkpointFn?: () => Promise<void>;
    layers?: MemoryLayer[];
    unifiedTools?: ReadonlyArray<Tool>;
    itemSchemas?: ItemSchemaRegistry;
    cwdState?: CwdState;
    _broadcaster?: EventBroadcaster;
    /**
     * Pre-chosen context id. When set, the ContextImpl adopts this id instead
     * of generating a fresh UUID. Used by `executeSpawn` so the child's
     * `ctx.id` matches the `executionId` keyed into the layer-state store —
     * otherwise writes via `ctx.memory[layerId].state` land on one id while
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

  get memory(): ContextMemory {
    if (!this._memory) {
      this._memory = this.layers ? buildContextMemory(this.layers, this) : EMPTY_MEMORY;
    }
    return this._memory;
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
    return this.channelStore.recv(ch, opts?.timeout);
  }

  send<T>(ch: Channel<T>, value: T): void {
    if (!this.channelStore) {
      throw new Error('No channel store configured');
    }
    this.channelStore.send(ch, value);
  }

  tryRecv<T>(ch: Channel<T>): T | null {
    if (!this.channelStore) {
      throw new Error('No channel store configured');
    }
    return this.channelStore.tryRecv(ch);
  }

  async checkpoint(): Promise<void> {
    if (this._checkpointFn) {
      await this._checkpointFn();
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
    this._aborted = true;
    this._abortReason = reason;
  }

  /**
   * @internal
   * Push a frame onto the execution frontier. Called by `execute()` at the
   * top of every step dispatch so that the frontier reflects exactly the
   * stack of steps currently in-flight on this context.
   */
  enterStep(frame: FrontierFrame): void {
    this._frontier.push(frame);
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
