/**
 * An agent's questions (`elicitation/create`) as held questions (spec 27
 * § Questions the agent asks, spec 08 § Held tool calls): the host sees the same
 * `tool_call_held` / `onHeld` / `pending()` question it sees for any other asker,
 * and never learns the step is an agent.
 */

import type {
  AcpBoundElicitationHandler,
  AcpCreateElicitationRequest,
  AcpCreateElicitationResponse,
  Context,
  ContextData,
  HeldQuestion,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { ContextImpl } from '../runtime/context-impl';
import type { HoldHost } from '../runtime/held-calls';
import { heldArgsHash, holdAndWait } from '../runtime/held-calls';

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

/** The question a person sees: the message, and the form or the page. */
function questionOf(request: AcpCreateElicitationRequest): HeldQuestion {
  const schema = Reflect.get(request, 'requestedSchema');
  const url = Reflect.get(request, 'url');
  return {
    message: request.message,
    ...(isRecord(schema)
      ? {
          schema,
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

/**
 * Answer an agent's questions by holding each for a person. The id is the step's
 * dispatch path, a hash of the request and its ordinal among identical requests,
 * so a resumed host asked the same question again finds the answer already given.
 * The agent is waiting on the answer, so the turn stays live while it is held.
 */
export function questionAsker(opts: QuestionAskerOptions): AcpBoundElicitationHandler {
  const seen = new Map<string, number>();
  const name = `${opts.agentId}:question`;
  return async (request) => {
    const identity = heldArgsHash(name, requestIdentity(request));
    const ordinal = seen.get(identity) ?? 0;
    seen.set(identity, ordinal + 1);
    const question = questionOf(request);
    const args = {
      message: question.message,
    };
    const answer = await holdAndWait({
      harness: frameworkCast<HoldHost>(opts.ctx.harness),
      ctx: opts.ctx,
      park: false,
      record: {
        callId: `${dispatchOf(opts.ctx, opts.stepId)}:question:${identity}#${ordinal}`,
        name,
        args,
        argsHash: heldArgsHash(name, args),
        reason: 'question',
        question,
      },
    });
    const resolution = answer.resolution;
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
  };
}

//#endregion
