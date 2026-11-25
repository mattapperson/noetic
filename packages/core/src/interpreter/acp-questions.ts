/**
 * An agent's questions (`elicitation/create`) as held questions (spec 27
 * § Questions the agent asks, spec 08 § Held tool calls): the host sees the same
 * `tool_call_held` / `onHeld` / `pending()` question it sees for any other asker,
 * and never learns the step is an agent.
 */

import type {
  AcpCreateElicitationRequest,
  AcpCreateElicitationResponse,
  AcpElicitationInfo,
  AgentScope,
  Context,
  ContextData,
  HeldQuestion,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { ContextImpl } from '../runtime/context-impl';
import type { HoldHost } from '../runtime/held-calls';
import {
  heldArgsHash,
  heldCallsOf,
  heldScopeOf,
  holdAndWait,
  mayWriteHolds,
} from '../runtime/held-calls';

//#region Types

/** Everything a question's hold is filed and shown under. */
export interface QuestionAskerOptions {
  ctx: Context<ContextData>;
  agentId: string;
  stepId: string;
}

type ElicitationContent = NonNullable<
  Extract<
    AcpCreateElicitationResponse,
    {
      action: 'accept';
    }
  >['content']
>;

//#endregion

//#region Helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The question a person sees: the message, and the form or the page. An ACP form
 * is closed — the agent takes only the fields it described — so an answer with
 * any other field is refused before the question settles.
 */
function questionOf(request: AcpCreateElicitationRequest): HeldQuestion {
  const schema = Reflect.get(request, 'requestedSchema');
  const url = Reflect.get(request, 'url');
  return {
    message: request.message,
    ...(isRecord(schema)
      ? {
          schema: {
            ...schema,
            additionalProperties: false,
          },
        }
      : {}),
    ...(typeof url === 'string'
      ? {
          url,
        }
      : {}),
  };
}

/** What identifies one request across hosts: who asks, where, and what. */
function requestIdentity(request: AcpCreateElicitationRequest): Record<string, unknown> {
  return {
    sessionId: Reflect.get(request, 'sessionId') ?? null,
    toolCallId: Reflect.get(request, 'toolCallId') ?? null,
    mode: request.mode,
    question: questionOf(request),
  };
}

/** The step's dispatch path, or its id on a run with no ledger. */
function dispatchOf(ctx: Context<ContextData>, stepId: string): string {
  return (ctx instanceof ContextImpl ? ctx.currentDispatch()?.path : undefined) ?? stepId;
}

/** An answer as the agent takes it: the form's fields, or none for a URL question. */
function acceptOf(output: unknown): AcpCreateElicitationResponse {
  if (!isRecord(output)) {
    return {
      action: 'accept',
    };
  }
  // Checked against the question's schema when it was answered (held-question.ts).
  return {
    action: 'accept',
    content: frameworkCast<ElicitationContent>(output),
  };
}

//#endregion

//#region Public API

/** Asks an agent's questions as held questions; see {@link questionAsker}. */
export interface QuestionAsker {
  /** Ask one question; `scope` names the nested agent asking, when not the step's own. */
  readonly ask: (
    request: AcpCreateElicitationRequest,
    info: AcpElicitationInfo,
    scope?: AgentScope,
  ) => Promise<AcpCreateElicitationResponse>;
  /** Drop every question this step asked, answered or not: the step is over. */
  release(): Promise<void>;
}

/**
 * Answer an agent's questions by holding each for a person. A question's id is
 * the step's dispatch path and a hash of the request with the agent's own
 * JSON-RPC id for it — which a keeper keeps when it asks a reattached host
 * again — so a resumed host asked the same question finds it, answered or
 * not, and never asks the person twice. Without that id, the ordinal among
 * identical requests stands in. An answer is kept until the step ends, so one
 * taken just before the host died is still there when the question comes back.
 * The agent is waiting on the answer, so the turn stays live while it is held.
 */
export function questionAsker(opts: QuestionAskerOptions): QuestionAsker {
  const seen = new Map<string, number>();
  const asked = new Set<string>();
  /**
   * Ids this host already asked under. An agent that asks again under the
   * same id on the same host is asking a new question; a new host after a
   * crash starts empty, so the keeper's re-ask finds the kept answer.
   */
  const answeredHere = new Map<string, number>();
  const name = `${opts.agentId}:question`;
  const harness = frameworkCast<HoldHost>(opts.ctx.harness);
  const idOf = (
    request: AcpCreateElicitationRequest,
    requestId: string | number | undefined,
  ): string => {
    const identity = heldArgsHash(name, {
      ...requestIdentity(request),
      requestId: requestId ?? null,
    });
    if (requestId !== undefined) {
      return `${dispatchOf(opts.ctx, opts.stepId)}:question:${identity}`;
    }
    const ordinal = seen.get(identity) ?? 0;
    seen.set(identity, ordinal + 1);
    return `${dispatchOf(opts.ctx, opts.stepId)}:question:${identity}#${ordinal}`;
  };
  return {
    ask: async (request, info, scope) => {
      const base = idOf(request, info.requestId);
      const again = answeredHere.get(base) ?? 0;
      answeredHere.set(base, again + 1);
      const callId = again === 0 ? base : `${base}~${again}`;
      asked.add(callId);
      const question = questionOf(request);
      const args = {
        message: question.message,
      };
      const answer = await holdAndWait({
        harness,
        ctx: opts.ctx,
        park: false,
        keepAnswer: true,
        record: {
          callId,
          name,
          args,
          argsHash: heldArgsHash(name, args),
          reason: 'question',
          question,
          ...(scope === undefined
            ? {}
            : {
                scope,
              }),
        },
      });
      return responseOf(answer.resolution);
    },
    release: async () => {
      if (!mayWriteHolds(opts.ctx)) {
        return;
      }
      const holds = heldCallsOf(harness);
      const scope = heldScopeOf(opts.ctx);
      for (const callId of asked) {
        await holds.close(scope, callId);
      }
      asked.clear();
    },
  };
}

/** The agent's answer: accept with the form's fields, decline, or cancel. */
function responseOf(
  resolution: Awaited<ReturnType<typeof holdAndWait>>['resolution'],
): AcpCreateElicitationResponse {
  if (resolution?.hasOutput === true) {
    return acceptOf(resolution.output);
  }
  if (resolution?.action === 'deny') {
    return {
      action: 'decline',
    };
  }
  return {
    action: 'cancel',
  };
}

//#endregion
