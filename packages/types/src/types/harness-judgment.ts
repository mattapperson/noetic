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
   * held until `harness.resolve()` answers it. Resolves the settled decision, so it
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
  /** Ties an answer to this exact call. Pass it back to `harness.resolve()`. */
  readonly argsHash: string;
  /**
   * `approval`: the tool has not run. `result`: it ran and left its result open.
   * `outcome`: a `durable` tool was running when the host died, and nobody knows
   * whether its effect landed.
   */
  readonly reason: 'approval' | 'result' | 'outcome';
  /** Epoch ms after which the hold runs out. */
  readonly dueAt?: number;
  /** What happens then: `deny` (the default) or `keep`. */
  readonly onDue?: 'deny' | 'keep';
  /** What a tool passed to `hold()`, for whoever answers. */
  readonly request?: unknown;
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
