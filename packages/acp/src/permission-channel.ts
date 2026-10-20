/**
 * Routing an ACP agent's permission requests to a human.
 *
 * ACP makes `session/request_permission` a client responsibility, but a
 * declarative policy can only answer what it was told in advance. When the
 * decision belongs to a person, the request has to leave the process and an
 * answer has to come back — which is what external channels are for.
 *
 * The shape mirrors `@noetic-tools/chat-sdk`'s tool-approval flow, deliberately:
 *
 * 1. A step's handler sends an {@link AcpPermissionPrompt} on
 *    {@link acpPermissionRequests} and parks on {@link acpPermissionDecisions}.
 * 2. The integration subscribes ONCE per harness —
 *    `harness.getChannelStream(acpPermissionRequests, ACP_PERMISSION_SCOPE)` —
 *    and shows the request to the user. One subscriber, because queue delivery
 *    is competing-consumer: a second would steal requests.
 * 3. The answer calls {@link resolveAcpPermission}, which broadcasts on the
 *    decision topic; the parked handler matching `requestId` unparks.
 *
 * Requests use a queue (each belongs to exactly one reviewer) and decisions a
 * topic (broadcast, each waiter filters for its own `requestId`) — per-request
 * channels would leak one channel state per prompt for the harness lifetime.
 */

import type {
  AcpPermissionHandler,
  AcpPermissionOutcome,
  ChannelHandle,
  ExternalChannel,
} from '@noetic-tools/types';
import { z } from 'zod';

//#region Scope

/**
 * Lifetime scope id for permission subscriptions and write handles. No
 * execution ever runs under it, so the stream and handle stay open until the
 * integration ends them itself.
 * @public
 */
export const ACP_PERMISSION_SCOPE = 'acp:permissions';

//#endregion

//#region Schemas

const PermissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.enum([
    'allow_once',
    'allow_always',
    'reject_once',
    'reject_always',
  ]),
});

/** @public A permission request on its way to a human. */
export const AcpPermissionPromptSchema = z.object({
  /** Correlates the answer with this request. */
  requestId: z.string(),
  /** Which agent is asking (`agentId` of the adapter). */
  agentId: z.string(),
  /** ACP session the request belongs to. */
  sessionId: z.string(),
  /** Harness thread, so a chat integration can route the prompt to the right conversation. */
  threadId: z.string(),
  /** The step whose turn triggered the request. */
  stepId: z.string(),
  /** Human-readable description of what the agent wants to do. */
  title: z.string(),
  /** ACP tool classification (`read`, `edit`, `execute`, …), when the agent set one. */
  kind: z.string().optional(),
  /** Raw tool input, for a UI that wants to show the command or diff. */
  rawInput: z.record(z.string(), z.unknown()).optional(),
  /** Exactly the options the agent offered — a UI should present these, not invent its own. */
  options: z.array(PermissionOptionSchema),
});

/** @public A permission request awaiting a human answer. */
export type AcpPermissionPrompt = z.infer<typeof AcpPermissionPromptSchema>;

/** @public The human's answer to an {@link AcpPermissionPrompt}. */
export const AcpPermissionReplySchema = z.object({
  requestId: z.string(),
  decision: z.enum([
    'allow',
    'deny',
    'cancel',
  ]),
  /** Pin an exact option the agent offered. Omit to let the client choose by `decision`. */
  optionId: z.string().optional(),
  reason: z.string().optional(),
});

/** @public The human's answer to a permission prompt. */
export type AcpPermissionReply = z.infer<typeof AcpPermissionReplySchema>;

//#endregion

//#region Channels

/** @public Permission requests from every ACP step of a harness, in the order they parked. */
export const acpPermissionRequests: ExternalChannel<AcpPermissionPrompt> = {
  name: 'acp:permission-requests',
  schema: AcpPermissionPromptSchema,
  mode: 'queue',
  external: true,
};

/** @public Decisions broadcast to every parked handler; each filters by its own `requestId`. */
export const acpPermissionDecisions: ExternalChannel<AcpPermissionReply> = {
  name: 'acp:permission-decisions',
  schema: AcpPermissionReplySchema,
  mode: 'topic',
  external: true,
};

//#endregion

//#region Public API

/** @public Options for {@link askUserForPermission}. */
export interface AskUserForPermissionOptions {
  /**
   * How long to wait for an answer, in milliseconds. On expiry the handler
   * resolves with {@link onTimeout} rather than hanging the agent's turn
   * forever. Defaults to 5 minutes.
   */
  timeout?: number;
  /**
   * What an unanswered prompt means. Defaults to denying: an unattended
   * request must not become an approval by running out the clock.
   */
  onTimeout?: AcpPermissionOutcome;
}

/**
 * Build an {@link AcpPermissionHandler} that asks a human over the channel pair
 * above. Pass it as a step's `onPermissionRequest`; it runs after the step's
 * declarative policy and steering have both abstained.
 * @public
 */
export function askUserForPermission(opts: AskUserForPermissionOptions = {}): AcpPermissionHandler {
  const timeout = opts.timeout ?? 5 * 60 * 1e3;
  const onTimeout: AcpPermissionOutcome = opts.onTimeout ?? {
    decision: 'deny',
    reason: 'no answer from the user before the permission request timed out',
  };

  return async (request, ctx, info) => {
    const requestId = crypto.randomUUID();
    const deadline = Date.now() + timeout;

    // Park on the decision topic BEFORE publishing the request. Topic delivery
    // reaches only subscribers that are parked at send time, so a reviewer who
    // answers immediately would otherwise answer into the void and the agent
    // would wait out the whole timeout.
    let waiting = ctx.recv(acpPermissionDecisions, {
      timeout,
    });

    await ctx.send(acpPermissionRequests, {
      requestId,
      agentId: info.agentId,
      sessionId: request.sessionId,
      threadId: ctx.threadId,
      stepId: info.stepId,
      title: request.toolCall.title ?? request.toolCall.toolCallId,
      kind: request.toolCall.kind ?? undefined,
      rawInput: request.toolCall.rawInput,
      options: request.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    });

    // Decisions are broadcast, so a waiter also sees answers meant for other
    // requests; keep reading until ours arrives. The deadline is shared across
    // the whole wait, not restarted per message, so another request's answer
    // cannot extend it.
    //
    // Re-parking between messages leaves a microtask-sized window in which a
    // decision could be missed — only reachable when two prompts are answered
    // in the same tick, and bounded by the timeout rather than hanging.
    while (true) {
      let reply: AcpPermissionReply;
      try {
        reply = await waiting;
      } catch {
        return onTimeout;
      }
      if (reply.requestId === requestId) {
        return {
          decision: reply.decision,
          optionId: reply.optionId,
          reason: reply.reason,
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return onTimeout;
      }
      waiting = ctx.recv(acpPermissionDecisions, {
        timeout: remaining,
      });
    }
  };
}

/**
 * Answer a prompt from outside the execution. Get the handle with
 * `harness.getChannelHandle(acpPermissionDecisions, ACP_PERMISSION_SCOPE)`.
 * @public
 */
export function resolveAcpPermission(
  handle: ChannelHandle<AcpPermissionReply>,
  reply: AcpPermissionReply,
): void {
  handle.send(reply);
}

//#endregion
