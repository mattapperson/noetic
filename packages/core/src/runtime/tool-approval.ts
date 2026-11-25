import type { Context, HeldCall, SteeringDecision } from '@noetic-tools/types';
import { SteeringAction } from '@noetic-tools/types';
import type { HeldRecord, HoldHost } from './held-calls';
import {
  announcerOf,
  HoldSignal,
  heldArgsHash,
  heldCallsOf,
  heldScopeOf,
  isOverdue,
  mayWriteHolds,
  toHeldCall,
  waitOnHeldCalls,
} from './held-calls';

//#region Types

/** How the approval stage settled a call, as recorded on its `tool.call` span. */
export const ApprovalOutcome = {
  Approved: 'approved',
  Denied: 'denied',
  /** A call with no id ran unapproved, because no approver is set and it cannot be held. */
  NoneConfigured: 'none_configured',
} as const;

export type ApprovalOutcome = (typeof ApprovalOutcome)[keyof typeof ApprovalOutcome];

export interface ToolApproval {
  outcome: ApprovalOutcome;
  decision: SteeringDecision;
}

const warnedHeld = new WeakMap<HoldHost, Set<string>>();

function warnHeldUnasked(harness: HoldHost, toolName: string): void {
  const names = warnedHeld.get(harness) ?? new Set<string>();
  warnedHeld.set(harness, names);
  if (names.has(toolName)) {
    return;
  }
  names.add(toolName);
  console.warn(
    `[noetic] tool '${toolName}' needs approval and harness '${harness.config.name}' has no approver, so its calls are held until someone answers. List them with harness.pending() and answer with a decision item passed to harness.execute(), or set AgentHarness({ approveToolCall }) to ask as each call is made.`,
  );
}

//#endregion

//#region Helpers

function approvalOf(decision: SteeringDecision): ToolApproval {
  return {
    outcome:
      decision.action === SteeringAction.Allow ? ApprovalOutcome.Approved : ApprovalOutcome.Denied,
    decision,
  };
}

function denied(guidance: string): ToolApproval {
  return approvalOf({
    action: SteeringAction.Deny,
    guidance,
  });
}

/** What a held approval settled as, or undefined while it is still open. */
function settledHold(held: HeldRecord, now: number): ToolApproval | undefined {
  const action = held.resolution?.action;
  if (action !== undefined) {
    return approvalOf({
      action,
      guidance: held.resolution?.guidance,
    });
  }
  if (isOverdue(held, now)) {
    return denied(`nobody approved '${held.name}' before the hold ran out`);
  }
  return undefined;
}

const warned = new WeakMap<HoldHost, Set<string>>();

function warnOnce(harness: HoldHost, toolName: string): void {
  let names = warned.get(harness);
  if (!names) {
    names = new Set();
    warned.set(harness, names);
  }
  if (names.has(toolName)) {
    return;
  }
  names.add(toolName);
  console.warn(
    `[noetic] tool '${toolName}' needs approval, but harness '${harness.config.name}' has no approver and the call has no id to hold it under, so it runs unapproved. Set AgentHarness({ approveToolCall }) to approve or refuse it.`,
  );
}

//#endregion

//#region Public API

/**
 * Ask whether a call that needs approval may run (spec 08 § Held tool calls).
 *
 * A call already held under `callId` answers from its record: its resolution, a
 * denial once its deadline has passed, or another hold. Otherwise the harness
 * approver decides. With no approver the call is held, so a person decides.
 *
 * An approver that throws denies the call.
 *
 * @throws HoldSignal when the call is to be held. The caller writes the record.
 */
export async function askApproval(params: {
  harness: HoldHost;
  toolName: string;
  toolArgs: unknown;
  callId?: string;
  /**
   * The id the call's held record is under, when it is not `callId`. The approver
   * is still shown `callId`, the id the call goes by everywhere else.
   */
  recordId?: string;
  ctx: Context;
  /**
   * The caller already matched the held record to this call, so `toolArgs` need not
   * hash the same. Set by a seam that sees the arguments in another shape.
   */
  matched?: boolean;
}): Promise<ToolApproval> {
  const holds = heldCallsOf(params.harness);
  const recordId = params.recordId ?? params.callId;
  const held =
    recordId === undefined ? undefined : await holds.load(heldScopeOf(params.ctx), recordId);
  const sameCall =
    held?.reason === 'approval' &&
    (params.matched === true || held.argsHash === heldArgsHash(params.toolName, params.toolArgs));
  if (held && sameCall) {
    const settled = settledHold(held, holds.now());
    if (settled) {
      return settled;
    }
    throw new HoldSignal({
      dueAt: held.dueAt,
      onDue: held.onDue,
    });
  }
  const approver = params.harness.config.approveToolCall;
  if (!approver) {
    if (params.callId === undefined) {
      // Nobody to ask and no id to hold it under. Approval is not something a
      // call gets by default: it is refused.
      warnOnce(params.harness, params.toolName);
      return denied(
        `'${params.toolName}' needs approval, and there is no approver and no call id to hold it under`,
      );
    }
    // Held, and nothing will ask anyone: a host that expected a prompt sees a
    // call that never finishes. Say where the call is and how it is answered.
    warnHeldUnasked(params.harness, params.toolName);
    throw new HoldSignal();
  }
  let decision: SteeringDecision;
  try {
    decision = await approver({
      toolName: params.toolName,
      toolArgs: params.toolArgs,
      callId: params.callId,
      ctx: params.ctx,
    });
  } catch (e) {
    return denied(
      `approval for tool '${params.toolName}' failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (decision.action !== SteeringAction.Hold) {
    return approvalOf(decision);
  }
  if (params.callId === undefined) {
    return denied(`'${params.toolName}' cannot be held: the call has no id`);
  }
  throw new HoldSignal({
    dueAt: decision.dueAt,
    onDue: decision.onDue,
  });
}

/**
 * `askApproval` for a caller with no round to come back to (an `invokeTool` step):
 * a call that is held waits here until it is answered, and the turn may park
 * meanwhile. Resolves the settled approval.
 *
 * @throws NoeticError `cancelled` when the context is aborted while it waits.
 */
export async function awaitApproval(params: {
  harness: HoldHost;
  toolName: string;
  toolArgs: unknown;
  callId: string;
  /**
   * The id the call's held record is under, when it is not `callId`: one that is
   * unique to this call in the run. The approver is still shown `callId`.
   */
  recordId?: string;
  ctx: Context;
  /** Called once, when the call is first held. */
  onHeld?: (held: HeldCall) => void;
  /** False when the turn must stay live while the call is held. Default true. */
  park?: boolean;
}): Promise<ToolApproval> {
  const holds = heldCallsOf(params.harness);
  const scope = heldScopeOf(params.ctx);
  const heldAs = params.recordId ?? params.callId;
  let announced = false;
  for (;;) {
    try {
      const approval = await askApproval(params);
      // Whether this process saw the call held or a resumed one found it answered,
      // the answer is spent here. Left in storage, it would approve the next ask
      // under this id with nobody asked.
      if (mayWriteHolds(params.ctx)) {
        await holds.close(scope, heldAs);
      }
      return approval;
    } catch (e) {
      if (!(e instanceof HoldSignal)) {
        throw e;
      }
      const open = mayWriteHolds(params.ctx)
        ? (record: HeldRecord) => holds.open(scope, record)
        : async (record: HeldRecord) => record;
      const record = await open({
        callId: heldAs,
        name: params.toolName,
        args: params.toolArgs,
        argsHash: heldArgsHash(params.toolName, params.toolArgs),
        reason: 'approval',
        ...(e.due.dueAt === undefined
          ? {}
          : {
              dueAt: e.due.dueAt,
            }),
        ...(e.due.onDue === undefined
          ? {}
          : {
              onDue: e.due.onDue,
            }),
      });
      if (!announced) {
        announced = true;
        (params.onHeld ?? announcerOf(params.harness, params.ctx))(toHeldCall(record));
      }
      await waitOnHeldCalls({
        harness: params.harness,
        ctx: params.ctx,
        callIds: [
          heldAs,
        ],
        park: params.park,
      });
    }
  }
}

//#endregion
