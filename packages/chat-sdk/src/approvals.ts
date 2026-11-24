import type {
  ChannelHandle,
  DecisionItem,
  ExternalChannel,
  ToolApprover,
} from '@noetic-tools/types';
import { z } from 'zod';

/**
 * Approval flow for gated chat tools, built on external channels:
 *
 * 1. A gated tool sends an `ApprovalRequest` (carrying its `threadId` for
 *    routing) on `approvalRequests` and waits on `approvalDecisions`.
 * 2. The integration subscribes ONCE per harness —
 *    `harness.getChannelStream(approvalRequests, APPROVAL_SCOPE)` — and posts
 *    an approval card to the request's thread. One subscriber, because queue
 *    delivery is competing-consumer: a second subscriber would steal
 *    requests, and channel delivery is harness-wide, not per-execution.
 * 3. The button click calls `resolveApproval(...)`, which broadcasts the
 *    decision back in; the tool matching the `requestId` unparks.
 *
 * `APPROVAL_SCOPE` is a harness-lifetime scope id: no execution ever runs
 * under it, so the subscription and write handle stay open until the
 * integration ends the stream itself (`break` / `iterator.return()`).
 */

/** Lifetime scope id for approval subscriptions and handles — never closed by any run. */
export const APPROVAL_SCOPE = 'chat-sdk:approvals';

export const ApprovalRequestSchema = z.object({
  requestId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
  /** Harness thread the gated call belongs to — routes the card to the right conversation. */
  threadId: z.string(),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  requestId: z.string(),
  approved: z.boolean(),
  reason: z.string().optional(),
});

export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** Requests from all gated tools of a harness, in the order they parked. */
export const approvalRequests: ExternalChannel<ApprovalRequest> = {
  name: 'chat-sdk:approval-requests',
  schema: ApprovalRequestSchema,
  mode: 'queue',
  external: true,
};

/**
 * Decisions broadcast to every waiting gated tool; each tool filters by its
 * own `requestId`. A single topic channel — per-request channels would leak
 * one channel state per approval for the harness lifetime.
 */
export const approvalDecisions: ExternalChannel<ApprovalDecision> = {
  name: 'chat-sdk:approval-decisions',
  schema: ApprovalDecisionSchema,
  mode: 'topic',
  external: true,
};

/** The slice of the harness `resolveApproval` needs. */
export interface ApprovalHarness {
  getChannelHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T>;
}

/**
 * Deliver a user's decision to the gated tool waiting on
 * `decision.requestId`. Returns `false` instead of throwing when the channel
 * is no longer open (e.g. a stale approval button clicked long after the
 * fact) — a platform action handler is no place for a `channel_closed`.
 */
export function resolveApproval(params: {
  harness: ApprovalHarness;
  decision: ApprovalDecision;
  /** Override when the integration subscribed under a custom scope id. */
  scopeId?: string;
}): boolean {
  const handle = params.harness.getChannelHandle(
    approvalDecisions,
    params.scopeId ?? APPROVAL_SCOPE,
  );
  if (handle.closed) {
    return false;
  }
  try {
    handle.send(params.decision);
    return true;
  } catch {
    return false;
  }
}

//#region Through the harness

/** How long a held approval waits for a click by default: five minutes. */
const DEFAULT_HOLD_MS = 3e5;

/**
 * An `approveToolCall` approver that asks in chat and holds the call
 * (Noetic spec 08 § Held tool calls).
 *
 * It sends an `ApprovalRequest` on `approvalRequests`, as a gated tool always
 * has, so the code that posts approval cards does not change. The request's id is
 * the tool call's own id. Then it answers `hold`: the call's record lives in the
 * harness's storage, the turn may park, and `answerApproval` settles it.
 *
 * Use it with tools built with `approval: 'harness'`:
 *
 * ```ts
 * new AgentHarness({ approveToolCall: chatApprover(), tools: await chatTools({ chat, approval: 'harness' }) });
 * ```
 *
 * @param options - `timeout` is how long the call stays held, in milliseconds,
 *   before it is denied. Default five minutes. `Infinity` holds it until answered.
 */
export function chatApprover(options: { timeout?: number } = {}): ToolApprover {
  const timeout = options.timeout ?? DEFAULT_HOLD_MS;
  return async ({ toolName, toolArgs, callId, ctx }) => {
    if (callId === undefined) {
      return {
        action: 'deny',
        guidance: `'${toolName}' has no call id to ask about`,
      };
    }
    await ctx.harness.send(
      approvalRequests,
      {
        requestId: callId,
        toolName,
        args: toolArgs,
        threadId: ctx.threadId,
      },
      ctx,
    );
    const now = ctx.harness.config.now?.() ?? Date.now();
    return Number.isFinite(timeout)
      ? {
          action: 'hold',
          dueAt: now + timeout,
        }
      : {
          action: 'hold',
        };
  };
}

/** The slice of the harness `answerApproval` needs. */
export interface HeldApprovalHarness extends ApprovalHarness {
  /**
   * Takes a decision for a held tool call, as `AgentHarness.execute()` does.
   * Absent on a harness that cannot hold one.
   */
  execute?(
    input: DecisionItem,
    options?: {
      threadId?: string;
    },
  ): Promise<void>;
}

/**
 * Deliver a user's decision, wherever the call is waiting. A call the harness
 * holds (see `chatApprover`) is answered with a decision item through `harness.execute()`, which also
 * wakes a parked turn; anything else goes to `resolveApproval` and the channel.
 *
 * Resolves `false` when nothing was waiting for the decision, such as a stale
 * button clicked long after the fact.
 */
export async function answerApproval(params: {
  harness: HeldApprovalHarness;
  decision: ApprovalDecision;
  /** The harness thread the request came from: `ApprovalRequest.threadId`. */
  threadId?: string;
  /** Override when the integration subscribed under a custom scope id. */
  scopeId?: string;
}): Promise<boolean> {
  const { harness, decision } = params;
  if (harness.execute) {
    try {
      await harness.execute(
        {
          type: 'noetic:decision',
          callId: decision.requestId,
          action: decision.approved ? 'allow' : 'deny',
          ...(decision.reason === undefined
            ? {}
            : {
                guidance: decision.reason,
              }),
        },
        {
          threadId: params.threadId,
        },
      );
      return true;
    } catch {
      // Not a call the harness holds: it may be one waiting on the channel.
    }
  }
  return resolveApproval(params);
}

//#endregion
