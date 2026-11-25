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
  // unknown `sessionUpdate` as opaque: it emits nothing.
  return frameworkCast<AcpSessionNotification>(params);
}

//#endregion

/** Where an `elicitation/create`'s JSON-RPC id rides in its params, for the client. */
const REQUEST_ID_META = 'noetic.tools/requestId';

/**
 * An agent's `elicitation/create` line with its JSON-RPC id copied into the
 * params' `_meta`, or undefined for any other line. The SDK hands the client a
 * request's params only; the id is what identifies the request across hosts,
 * since a keeper asks a reattached host again with the agent's own id. Riding
 * in the request itself, it cannot drift onto another request.
 */
export function tagElicitationRequest(line: string): string | undefined {
  if (!line.includes('"elicitation/create"')) {
    return undefined;
  }
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(message) || message.method !== 'elicitation/create' || !isRecord(message.params)) {
    return undefined;
  }
  const id = message.id;
  if (typeof id !== 'string' && typeof id !== 'number') {
    return undefined;
  }
  const meta = isRecord(message.params._meta) ? message.params._meta : {};
  return JSON.stringify({
    ...message,
    params: {
      ...message.params,
      _meta: {
        ...meta,
        [REQUEST_ID_META]: id,
      },
    },
  });
}

/** A request's params as the agent sent them, and the JSON-RPC id the stream tagged them with. */
export function untagElicitation<
  T extends {
    _meta?: Record<string, unknown> | null;
  },
>(
  params: T,
): {
  request: T;
  requestId?: string | number;
} {
  const meta = params._meta;
  if (!meta || !Object.hasOwn(meta, REQUEST_ID_META)) {
    return {
      request: params,
    };
  }
  const { [REQUEST_ID_META]: tagged, ...rest } = meta;
  const requestId = typeof tagged === 'string' || typeof tagged === 'number' ? tagged : undefined;
  const request: T = {
    ...params,
    _meta: Object.keys(rest).length > 0 ? rest : undefined,
  };
  return {
    request,
    ...(requestId === undefined
      ? {}
      : {
          requestId,
        }),
  };
}

//#endregion

//#region Public API

/**
 * Pass the agent's stream through, handing `deliver` each `session/update`
 * the SDK would reject for its variant instead of passing it on, and tagging
 * each `elicitation/create` with its JSON-RPC id.
 */
export function divertNewerUpdates(
  readable: ReadableStream<Uint8Array>,
  deliver: (notification: AcpSessionNotification) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = '';
  const pass = (line: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
    const tagged = tagElicitationRequest(line);
    if (tagged !== undefined) {
      controller.enqueue(encoder.encode(`${tagged}\n`));
      return;
    }
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
          const tagged = tagElicitationRequest(tail);
          if (tagged !== undefined) {
            controller.enqueue(encoder.encode(tagged));
            return;
          }
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
