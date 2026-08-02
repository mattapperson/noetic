import type { ChannelHandle, ExternalChannel } from '@noetic-tools/types';
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
