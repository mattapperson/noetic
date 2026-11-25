/**
 * Questions a served run holds for a person (spec 31, spec 27 § Questions the
 * agent asks): the editor driving the run is the person's side of the wire, so
 * each held question is put to it as `elicitation/create` when it can show
 * forms, and declined at once when it cannot — a served turn never waits on
 * nobody.
 */

import type * as acp from '@agentclientprotocol/sdk';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { DecisionItem, HeldCall, StreamEvent } from '@noetic-tools/types';
import { DECISION_ITEM_TYPE, readHeldCallEvent } from '@noetic-tools/types';
import type { AcpServeHarness } from './serve-types';

//#region Types

/** What forwarding a served session's questions needs. */
export interface ServedQuestionsOptions {
  conn: AgentSideConnection;
  harness: AcpServeHarness;
  sessionId: string;
  /** What the editor advertised in `initialize`. */
  capabilities: acp.ClientCapabilities | undefined;
}

//#endregion

//#region Helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decline(call: HeldCall): DecisionItem {
  return {
    type: DECISION_ITEM_TYPE,
    callId: call.callId,
    argsHash: call.argsHash,
    action: 'deny',
  };
}

/** The editor's answer as a decision, or undefined when it cancelled. */
function decisionOf(
  call: HeldCall,
  answer: acp.CreateElicitationResponse,
): DecisionItem | undefined {
  if (answer.action === 'accept') {
    return {
      type: DECISION_ITEM_TYPE,
      callId: call.callId,
      argsHash: call.argsHash,
      output: answer.content ?? {},
    };
  }
  if (answer.action === 'decline') {
    return decline(call);
  }
  return undefined;
}

/** Put one held question to the editor, or decline it when the editor cannot show it. */
async function answerQuestion(opts: ServedQuestionsOptions, call: HeldCall): Promise<void> {
  const question = call.question;
  const schema = question?.schema;
  const canAsk =
    opts.capabilities?.elicitation?.form !== undefined &&
    opts.capabilities?.elicitation?.form !== null;
  if (!question || !isRecord(schema) || !canAsk) {
    await settle(opts, decline(call));
    return;
  }
  // An editor that fails the request (method not found, a dropped wire) has
  // not answered: decline, so the turn never waits on it.
  const answer = await opts.conn
    .createElicitation({
      mode: 'form',
      sessionId: opts.sessionId,
      message: question.message,
      requestedSchema: {
        type: 'object',
        properties: isRecord(schema.properties) ? schema.properties : {},
        ...(Array.isArray(schema.required)
          ? {
              required: schema.required.filter((name): name is string => typeof name === 'string'),
            }
          : {}),
      },
    })
    .catch(() => undefined);
  if (!answer) {
    await settle(opts, decline(call));
    return;
  }
  const decision = decisionOf(call, answer);
  if (!decision) {
    return;
  }
  // An answer the question refuses (it does not fit the form) declines it.
  await opts.harness
    .execute(decision, {
      threadId: opts.sessionId,
    })
    .catch(() => settle(opts, decline(call)));
}

/** Give a decision; one the run no longer takes (the turn moved on) is dropped. */
async function settle(opts: ServedQuestionsOptions, decision: DecisionItem): Promise<void> {
  await opts.harness
    .execute(decision, {
      threadId: opts.sessionId,
    })
    .catch(() => undefined);
}

//#endregion

//#region Public API

/**
 * Answer each question a served turn holds, as its events are pumped: through
 * the editor when it advertised form elicitation, else by declining it. A
 * question the editor's answer no longer fits stays held, as any refused
 * answer does.
 */
export function servedQuestionAnswerer(opts: ServedQuestionsOptions): (event: StreamEvent) => void {
  return (event) => {
    const read = readHeldCallEvent(event);
    if (read?.type !== 'held' || read.call.reason !== 'question') {
      return;
    }
    void answerQuestion(opts, read.call).catch(() => undefined);
  };
}

//#endregion
