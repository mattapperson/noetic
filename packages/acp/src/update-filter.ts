/**
 * Session updates newer than the protocol library.
 *
 * The SDK validates every `session/update` notification against the variants
 * it knows and answers any other with `-32602 Invalid params`, dropping it. An
 * agent built on a newer protocol revision would then lose data and log an
 * error for normal traffic. This filter sits on the agent's byte stream before
 * the SDK: a `session/update` whose variant the SDK does not know is handed to
 * the host as it is and kept from the SDK. Every other line passes through
 * byte-identical.
 */

import type { AcpSessionNotification } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';

//#region Known variants

type SessionUpdateKind = AcpSessionNotification['update']['sessionUpdate'];

/**
 * Every variant the pinned SDK parses. A `Record` over the union, so a library
 * bump that adds one fails to compile until it is listed here.
 */
const KNOWN: Record<SessionUpdateKind, true> = {
  user_message_chunk: true,
  agent_message_chunk: true,
  agent_thought_chunk: true,
  tool_call: true,
  tool_call_update: true,
  plan: true,
  plan_update: true,
  plan_removed: true,
  available_commands_update: true,
  current_mode_update: true,
  config_option_update: true,
  session_info_update: true,
  usage_update: true,
  notice: true,
  compaction_update: true,
  compaction_summary_chunk: true,
  subagent_update: true,
  session_message: true,
  session_message_chunk: true,
};

function isKnown(kind: string): boolean {
  return Object.hasOwn(KNOWN, kind);
}

//#endregion

//#region Helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The notification when `line` is a `session/update` with a variant the SDK
 * does not know; otherwise undefined.
 */
export function newerSessionUpdate(line: string): AcpSessionNotification | undefined {
  if (!line.includes('"session/update"')) {
    return undefined;
  }
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(message) || message.method !== 'session/update' || 'id' in message) {
    return undefined;
  }
  const params = message.params;
  if (!isRecord(params) || typeof params.sessionId !== 'string' || !isRecord(params.update)) {
    return undefined;
  }
  const kind = params.update.sessionUpdate;
  if (typeof kind !== 'string' || isKnown(kind)) {
    return undefined;
  }
  // A variant from a newer protocol revision: the host's handlers treat an
  // unknown `sessionUpdate` as opaque (the event bridge's `acp.<name>` event).
  return frameworkCast<AcpSessionNotification>(params);
}

//#endregion

//#region Public API

/**
 * Pass the agent's stream through, handing `deliver` each `session/update`
 * the SDK would reject for its variant instead of passing it on.
 */
export function divertNewerUpdates(
  readable: ReadableStream<Uint8Array>,
  deliver: (notification: AcpSessionNotification) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = '';
  const pass = (line: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
    const newer = newerSessionUpdate(line);
    if (newer) {
      deliver(newer);
      return;
    }
    controller.enqueue(encoder.encode(`${line}\n`));
  };
  return readable.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        carry += decoder.decode(chunk, {
          stream: true,
        });
        let newline = carry.indexOf('\n');
        while (newline >= 0) {
          pass(carry.slice(0, newline), controller);
          carry = carry.slice(newline + 1);
          newline = carry.indexOf('\n');
        }
      },
      flush(controller) {
        const tail = carry + decoder.decode();
        if (tail.length > 0) {
          const newer = newerSessionUpdate(tail);
          if (newer) {
            deliver(newer);
            return;
          }
          controller.enqueue(encoder.encode(tail));
        }
      },
    }),
  );
}

//#endregion
