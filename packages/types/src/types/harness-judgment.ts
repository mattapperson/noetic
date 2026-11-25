import type { LLMResponse } from './common';
import type { Context } from './context';
import type { ContextLayer } from './context-layer';
import type { DecideRequest, DecideResponse, DecisionRecord } from './decide';
import type { OnSteerParams, SteeringDecision, SteerVerdict } from './steering';

/**
 * @public The judgment calls an agent harness makes for a step: the steering
 * hooks around tool and model calls, and typed decisions. Part of
 * `AgentHarnessContract`.
 */
export interface HarnessJudgmentContract {
  /** Answer typed questions with a decision model, or estimate with a chat model. See spec 32. */
  decide(request: DecideRequest): Promise<DecideResponse>;
  /** Run every layer's `onDecision` hook, in slot order. */
  notifyDecision(layers: ContextLayer[], record: DecisionRecord, ctx: Context): Promise<void>;
  beforeToolCall(
    layers: ContextLayer[],
    toolName: string,
    toolArgs: unknown,
    ctx: Context,
    callId?: string,
  ): Promise<SteeringDecision>;
  afterModelCall(
    layers: ContextLayer[],
    response: LLMResponse,
    ctx: Context,
  ): Promise<SteeringDecision>;
  /**
   * Ask whether an action that needs a person's go-ahead may run, by the harness's
   * one approval rule (spec 08 § Held tool calls): its `approveToolCall` approver
   * decides, and with none, or when the approver answers `hold`, the action is
   * held until a decision passed to `harness.execute()` answers it. Resolves the settled decision, so it
   * waits for as long as the action is held.
   *
   * Optional: a harness without it has no approval seam, and callers fall back to
   * their own rule.
   */
  approve?(request: ApproveRequest): Promise<SteeringDecision>;
  /**
   * Run a steer through every layer's `onSteer` hook, in slot order. A harness
   * without it lands each steer at its delivery mode's default point, unchanged.
   */
  onSteer?(
    layers: ContextLayer[],
    params: Pick<OnSteerParams, 'steer' | 'point' | 'action' | 'pendingCalls'>,
    ctx: Context,
  ): Promise<SteerVerdict>;
}

/** @public What `harness.approve()` is asked about. */
export interface ApproveRequest {
  /** The name the action is shown under and held as. */
  toolName: string;
  /** What it will be done with: exactly what a person is asked to approve. */
  toolArgs: unknown;
  /** Identifies the action. The same id, asked again after a resume, finds its answer. */
  callId: string;
  ctx: Context;
  /**
   * Whether the turn may park while the action is held. Default `true`. Pass
   * `false` when something outside the run is waiting on the answer and would not
   * survive the turn stopping, such as a live agent session.
   */
  park?: boolean;
}

/**
 * @public Parameters passed to the harness approver for a call to a tool that
 * declares `needsApproval`.
 */
export interface ApproveToolCallParams {
  toolName: string;
  /** The validated arguments — exactly what `execute` receives if the call is approved. */
  toolArgs: unknown;
  /** Correlation id of the pending call; see `BeforeToolCallParams.callId`. */
  callId?: string;
  /**
   * The calling step's context. An approver that waits on a human passes it
   * to `ctx.harness.send` / `ctx.harness.recv` to park on a channel.
   */
  ctx: Context;
}

/**
 * @public Decides whether a call to a tool that declares `needsApproval` may
 * run. Configured once per harness (`AgentHarness({ approveToolCall })`) and
 * consulted after every `beforeToolCall` layer has allowed the call. `allow`
 * runs the call; any other action refuses it, with `guidance` as the reason.
 * May be async and may wait — e.g. on a channel a human answers.
 */
export type ToolApprover = (
  params: ApproveToolCallParams,
) => SteeringDecision | Promise<SteeringDecision>;

//#region Held calls

/**
 * @public A tool call left open for a person (spec 08 § Held tool calls). Listed by
 * `harness.pending()` and carried by the `tool_call_held` event.
 */
export interface HeldCall {
  readonly callId: string;
  /** The tool's name. */
  readonly name: string;
  /** The validated arguments: exactly what the tool receives if the call is approved. */
  readonly args: unknown;
  /** Ties an answer to this exact call. Pass it back in the decision item. */
  readonly argsHash: string;
  /**
   * `approval`: the tool has not run. `result`: it ran and left its result open.
   * `outcome`: a `durable` tool was running when the host died, and nobody knows
   * whether its effect landed. `question`: a person is asked for input
   * ({@link question}); `{ output }` answers it, `deny` declines it.
   */
  readonly reason: 'approval' | 'result' | 'outcome' | 'question';
  /** Epoch ms after which the hold runs out. */
  readonly dueAt?: number;
  /** What happens then: `deny` (the default) or `keep`. */
  readonly onDue?: 'deny' | 'keep';
  /** What a tool passed to `hold()`, for whoever answers. */
  readonly request?: unknown;
  /** The question, on a call held with `reason: 'question'`. */
  readonly question?: HeldQuestion;
}

/**
 * @public A question put to a person (spec 08 § Held tool calls): a long task's
 * `input_required`, or a coding agent's `elicitation/create`.
 */
export interface HeldQuestion {
  /** What the person is asked. */
  readonly message: string;
  /**
   * A JSON Schema object the answer must match: `type: 'object'` with flat
   * `properties` (`string`, `number`, `integer`, `boolean`, optionally `enum`)
   * and `required`. Absent: any JSON value answers.
   */
  readonly schema?: Readonly<Record<string, unknown>>;
  /** A page the person is sent to instead of a form. */
  readonly url?: string;
}

/**
 * @public The answer to a held call: a decision for one that waits for approval, an
 * output for one that waits for its result. A call held as `outcome` takes either:
 * an output says it landed and gives its result, `allow` runs it again, and
 * `deny` or `guide` refuses it.
 */
export type HeldResolution =
  | {
      readonly action: 'allow' | 'deny' | 'guide';
      readonly guidance?: string;
    }
  | {
      readonly output: unknown;
    };

/**
 * @public How a held call stopped being held (spec 08 § Held tool calls). Carried by the
 * `tool_call_settled` event, and as `signal.reason` of the `onHeld` handler's signal.
 *
 * - `answer`: a decision settled it, from `execute()`, from the `onHeld` handler
 *   itself, or from another harness over the same storage. A call another harness
 *   settled and finished its turn on is reported as answered, however it ended.
 * - `due`: its deadline passed with `onDue: 'deny'`.
 * - `skipped`: a steer applied at the `held` steer point skipped it.
 * - `cancelled`: its turn was aborted, interrupted or abandoned, the agent that asked
 *   stopped waiting, or the harness closed.
 */
export interface HeldCallSettled {
  readonly callId: string;
  readonly name: string;
  readonly argsHash: string;
  readonly reason: HeldCall['reason'];
  readonly by: 'answer' | 'due' | 'skipped' | 'cancelled';
}

/** @public What the `onHeld` handler is given beside the call. */
export interface HeldCallContext {
  /**
   * Aborts once the call is settled any way at all; `signal.reason` is the
   * `HeldCallSettled`. A host closes the question it showed when it aborts. A call
   * settled by another harness over shared storage is seen within two seconds.
   */
  readonly signal: AbortSignal;
  /** The execution the call is held under. */
  readonly executionId: string;
  /** The thread, when the call is held by a thread's turn. */
  readonly threadId?: string;
}

/**
 * @public Puts a held call in front of a person (`AgentHarnessOpts.onHeld`). Called once
 * per question per process. Return the person's answer, taken as a decision item passed
 * to `execute()` is, or `undefined` to leave the call held for an answer that comes
 * another way. An answer returned after `signal` aborted is dropped.
 */
export type HeldCallHandler = (
  call: HeldCall,
  held: HeldCallContext,
) => HeldResolution | undefined | Promise<HeldResolution | undefined>;

/**
 * @public What a steer does at the `held` steer point before any layer has a say:
 * `apply` skips the held calls for it, `defer` keeps it queued behind them.
 */
export type HeldSteerPolicy = 'apply' | 'defer';

/** @public What a tool returns to leave its result open: see `hold()`. */
export interface ToolHold {
  readonly kind: 'noetic/tool-hold';
  /** Passed to whoever answers, as `HeldCall.request`. */
  readonly request?: unknown;
  readonly dueAt?: number;
  readonly onDue?: 'deny' | 'keep';
}

//#endregion

//#region Trail

/**
 * @public One step a run finished, as its trail keeps it (spec 23 § The trail):
 * who ran it, under which flow version, and the receipt of what it did. A mark
 * outlives the ledger entry it came from.
 */
export interface TrailMark {
  readonly executionId: string;
  /** The step's ledger path. */
  readonly path: string;
  readonly stepId: string;
  readonly kind: string;
  /** ISO time the step finished. */
  readonly completedAt: string;
  /** The flow version the step ran under, when the harness names one. */
  readonly version?: string;
  /** The lease term of the harness that ran it, on storage with `swap`. */
  readonly term?: number;
  /** That harness's name in the lease. */
  readonly holder?: string;
  /** The receipt of a step with a lasting effect, when its output carried one. */
  readonly receipt?: unknown;
}

/**
 * @public A tool call an execution's step ledger holds, so a resume of that execution
 * goes on from it rather than having the model ask for it again (spec 23a § Tool calls
 * in a round). The model's request is on record; `settled` says whether its result is too.
 */
export interface RecordedToolCall {
  /** The call id the model gave the call. */
  readonly callId: string;
  /** The tool the model called. */
  readonly name: string;
  /** The ledger path of the entry that holds the request: a step, or one of its rounds. */
  readonly path: string;
  /**
   * The call's result is on record too: a resume replays it, the result item
   * included, and the tool does not run. False when only the request is (a round cut
   * off while the call ran): a resume does not replay a result for it. The call runs
   * again with the idempotency key it had, unless its tool is `durable: true` (the
   * call is held for a person) or it needs approval (it waits for one).
   */
  readonly settled: boolean;
}

/**
 * @public
 * A thread's turn as storage holds it, when a wake is about to run it again
 * (spec 23 § Parked turns): what `AgentHarnessOpts.turnOptions` is asked about.
 */
export interface StoredTurn {
  readonly threadId: string;
  readonly executionId: string;
  /** The ids of the messages the turn delivers, in order. */
  readonly messageIds: ReadonlyArray<string>;
  /** The flow version the turn last ran under, when the harness names one. */
  readonly version?: string;
  /** Set while the turn is parked. */
  readonly parked?: {
    readonly until?: number;
  };
  /** Set while the turn is cut (spec 23 § Cut turns). */
  readonly cut?: {
    readonly reason: string;
    readonly count: number;
    readonly at: number;
  };
}

/**
 * @public
 * What a thread's stored record holds (spec 23a § Sessions): what
 * `AgentHarness.getStoredThread` resolves, so a host decides whether to seed
 * history without reading storage keys.
 */
export interface StoredThread {
  readonly threadId: string;
  /** The record holds history, from a finished turn or `seedSessionHistory`. */
  readonly hasHistory: boolean;
  /** The turn in flight, cut off or parked, as `turnOptions` sees it. */
  readonly turn?: StoredTurn;
}

/** @public A turn that stopped rather than redo a recorded effect (spec 23 § Versions). */
export interface StuckTurn {
  readonly threadId: string;
  readonly executionId: string;
  /** The ledger path of the step whose recorded effect no longer matches. */
  readonly path: string;
  /** The version the step was recorded under. */
  readonly from: string;
  /** The version the turn was resumed under. */
  readonly to: string;
}

//#endregion
