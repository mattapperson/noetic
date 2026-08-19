/**
 * Turn translation for the server direction: the client-direction event
 * bridge's table (spec 27, "Output → harness events") run backwards. One pump
 * consumes the harness's full event stream for a single prompt turn and emits
 * `session/update` notifications until the turn boundary resolves the
 * `session/prompt` request with a stop reason.
 */

import type { AcpSessionNotification, AcpStopReason, StreamEvent } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';

//#region Types

/** One `session/update` payload. */
export type ServeSessionUpdate = AcpSessionNotification['update'];

/** How a tool call is presented on the wire. */
export interface ServeToolCallPresentation {
  title: string;
  kind?: ServeToolCallKind;
  locations?: Array<{
    path: string;
  }>;
  /** Initial status: `pending` when the policy will ask, `in_progress` otherwise. */
  status: 'pending' | 'in_progress';
}

type ServeToolCallKind = Extract<
  ServeSessionUpdate,
  {
    sessionUpdate: 'tool_call';
  }
>['kind'];

/** @public How a served prompt turn ended. */
export type ServeTurnOutcome =
  | {
      kind: 'stop';
      stopReason: AcpStopReason;
    }
  | {
      kind: 'error';
      message: string;
    };

export interface PumpTurnParams {
  events: AsyncIterable<StreamEvent>;
  /** The id passed to `execute()`; claims the turn in `turn_started.messageIds`. */
  messageId: string;
  /** Send one notification to the client. */
  notify(update: ServeSessionUpdate): Promise<void>;
  /** Resolve presentation for a first-party tool call. */
  present(toolName: string, callId: string, args: unknown): ServeToolCallPresentation;
  /** Whether `session/cancel` was received for this session. */
  cancelRequested(): boolean;
}

//#endregion

//#region Claim helpers (same suffix-matching rules as chat-sdk's translator)

function hasEventName(event: StreamEvent, name: string): boolean {
  return event.source === 'framework' && event.type.endsWith(`:${name}`);
}

type TurnClaim =
  | {
      kind: 'ours';
      turnId: string | null;
      primary: boolean;
    }
  | {
      kind: 'none';
    };

function matchClaim(event: StreamEvent, messageId: string): TurnClaim {
  if (!hasEventName(event, 'turn_started') && !hasEventName(event, 'inbox_injected')) {
    return {
      kind: 'none',
    };
  }
  const ids = event.data.messageIds;
  if (!Array.isArray(ids) || !ids.includes(messageId)) {
    return {
      kind: 'none',
    };
  }
  return {
    kind: 'ours',
    turnId: typeof event.data.turnId === 'string' ? event.data.turnId : null,
    // When queued prompts coalesce into one turn, only the FIRST id's pump
    // sends notifications — the others resolve silently at the same boundary,
    // so the client never sees the turn twice.
    primary: ids[0] === messageId,
  };
}

function matchesTurn(event: StreamEvent, turnId: string | null): boolean {
  return turnId === null || event.data.turnId === turnId;
}

//#endregion

//#region Event readers

function readToolCall(event: StreamEvent): {
  name: string;
  callId: string;
} | null {
  const { name, callId } = event.data;
  if (typeof name !== 'string' || typeof callId !== 'string') {
    return null;
  }
  return {
    name,
    callId,
  };
}

/**
 * Capture parsed args from the model's completed function_call item so
 * presentation (title functions, locations) can see them; emitted before the
 * tool round runs, so it always precedes the matching `tool_call_started`.
 */
function readFunctionCallArgs(event: StreamEvent): {
  callId: string;
  args: unknown;
} | null {
  if (event.type !== 'response.output_item.done') {
    return null;
  }
  const item = event.data.item;
  if (typeof item !== 'object' || item === null) {
    return null;
  }
  const record = frameworkCast<Record<string, unknown>>(item);
  if (record.type !== 'function_call' || typeof record.callId !== 'string') {
    return null;
  }
  let args: unknown;
  if (typeof record.arguments === 'string') {
    try {
      args = JSON.parse(record.arguments);
    } catch {
      args = record.arguments;
    }
  }
  return {
    callId: record.callId,
    args,
  };
}

/**
 * Prefix applied to a nested sub-agent's tool-call ids so they can never
 * collide with a first-party call's id in the same session.
 */
const NESTED_ID_PREFIX = 'sub:';

/**
 * A nested `step.acpAgent` turn re-emits its protocol traffic as
 * `acp.<sessionUpdate>` sdk events carrying the raw update — the proxy path.
 * Only call-shaped updates are forwarded (message chunks already surface
 * through the model-stream events and would double otherwise), each is
 * shape-checked before it can reach the wire, and tool-call ids are
 * namespaced into the sub-agent's own id space.
 */
function readNestedUpdate(event: StreamEvent): ServeSessionUpdate | null {
  if (!event.type.startsWith('acp.')) {
    return null;
  }
  const update = event.data.update;
  if (typeof update !== 'object' || update === null) {
    return null;
  }
  const record = frameworkCast<Record<string, unknown>>(update);
  if (record.sessionUpdate === 'plan') {
    return Array.isArray(record.entries) ? frameworkCast<ServeSessionUpdate>(update) : null;
  }
  if (record.sessionUpdate !== 'tool_call' && record.sessionUpdate !== 'tool_call_update') {
    return null;
  }
  if (typeof record.toolCallId !== 'string') {
    return null;
  }
  if (record.sessionUpdate === 'tool_call' && typeof record.title !== 'string') {
    return null;
  }
  return frameworkCast<ServeSessionUpdate>({
    ...record,
    toolCallId: `${NESTED_ID_PREFIX}${record.toolCallId}`,
  });
}

//#endregion

//#region Pump

/**
 * Consume the harness event stream for one prompt turn, translating to
 * `session/update` notifications, and return how the turn ended.
 */
export async function pumpTurnEvents(params: PumpTurnParams): Promise<ServeTurnOutcome> {
  let claimed = false;
  let primary = false;
  let turnId: string | null = null;
  const argsByCallId = new Map<string, unknown>();
  /** Calls started but not completed — flushed at the turn boundary so the client is never left with a spinner. */
  const openCalls = new Set<string>();

  const flushOpenCalls = async (status: 'completed' | 'failed'): Promise<void> => {
    for (const toolCallId of openCalls) {
      await notifyIfPrimary(params, primary, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status,
      });
    }
    openCalls.clear();
  };

  for await (const event of params.events) {
    if (!claimed) {
      const claim = matchClaim(event, params.messageId);
      if (claim.kind === 'ours') {
        claimed = true;
        primary = claim.primary;
        turnId = claim.turnId;
      }
      continue;
    }

    if (event.source === 'sdk') {
      if (event.type === 'response.output_text.delta' && typeof event.data.delta === 'string') {
        await notifyIfPrimary(params, primary, textChunk('agent_message_chunk', event.data.delta));
        continue;
      }
      if (event.type === 'response.reasoning.delta' && typeof event.data.delta === 'string') {
        await notifyIfPrimary(params, primary, textChunk('agent_thought_chunk', event.data.delta));
        continue;
      }
      const fc = readFunctionCallArgs(event);
      if (fc) {
        argsByCallId.set(fc.callId, fc.args);
        continue;
      }
      const nested = readNestedUpdate(event);
      if (nested) {
        await notifyIfPrimary(params, primary, nested);
      }
      continue;
    }

    if (hasEventName(event, 'tool_call_started')) {
      const call = readToolCall(event);
      if (call) {
        openCalls.add(call.callId);
        const presentation = params.present(call.name, call.callId, argsByCallId.get(call.callId));
        await notifyIfPrimary(params, primary, {
          sessionUpdate: 'tool_call',
          toolCallId: call.callId,
          title: presentation.title,
          kind: presentation.kind,
          status: presentation.status,
          locations: presentation.locations,
          rawInput: asRecord(argsByCallId.get(call.callId)),
        });
      }
      continue;
    }
    if (hasEventName(event, 'tool_call_completed')) {
      const call = readToolCall(event);
      if (call) {
        openCalls.delete(call.callId);
        const output = typeof event.data.output === 'string' ? event.data.output : undefined;
        await notifyIfPrimary(params, primary, {
          sessionUpdate: 'tool_call_update',
          toolCallId: call.callId,
          status: event.data.error === true ? 'failed' : 'completed',
          // The tool's output (or failure text) as renderable content — the
          // spec's "completed with the output as content, failed carrying the
          // error".
          content:
            output !== undefined
              ? [
                  {
                    type: 'content',
                    content: {
                      type: 'text',
                      text: output,
                    },
                  },
                ]
              : undefined,
        });
      }
      continue;
    }
    if (hasEventName(event, 'turn_completed') && matchesTurn(event, turnId)) {
      await flushOpenCalls('completed');
      return {
        kind: 'stop',
        stopReason: 'end_turn',
      };
    }
    if (hasEventName(event, 'turn_aborted') && matchesTurn(event, turnId)) {
      await flushOpenCalls('failed');
      // The typed error kind (spec 31 gate contract) classifies the abort;
      // the session-level cancel flag covers aborts that carry no kind (a
      // host-initiated harness.abort has only a reason string).
      const errorKind = typeof event.data.errorKind === 'string' ? event.data.errorKind : undefined;
      if (errorKind === 'cancelled' || params.cancelRequested()) {
        return {
          kind: 'stop',
          stopReason: 'cancelled',
        };
      }
      if (errorKind === 'model_refused') {
        return {
          kind: 'stop',
          stopReason: 'refusal',
        };
      }
      if (errorKind === 'budget_exceeded') {
        // The closest wire vocabulary for a spent token budget — an editor
        // renders it as a native budget stop instead of a generic error.
        return {
          kind: 'stop',
          stopReason: 'max_tokens',
        };
      }
      return {
        kind: 'error',
        message: typeof event.data.reason === 'string' ? event.data.reason : 'turn aborted',
      };
    }
  }

  // The stream ended without a boundary — the harness (or connection) is
  // shutting down. Cancelled is the honest stop reason: the turn did not
  // complete and no error was reported.
  return {
    kind: 'stop',
    stopReason: 'cancelled',
  };
}

async function notifyIfPrimary(
  params: PumpTurnParams,
  primary: boolean,
  update: ServeSessionUpdate,
): Promise<void> {
  if (!primary) {
    return;
  }
  await params.notify(update);
}

function textChunk(
  kind: 'agent_message_chunk' | 'agent_thought_chunk',
  text: string,
): ServeSessionUpdate {
  return {
    sessionUpdate: kind,
    content: {
      type: 'text',
      text,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return frameworkCast<Record<string, unknown>>(value);
}

//#endregion
