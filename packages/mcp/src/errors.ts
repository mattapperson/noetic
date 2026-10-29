/**
 * Error mapping (spec 36 § Errors). A server refuses an operation with an MCP
 * tool error whose `structuredContent` is `{ code, message, details? }`; the
 * bridge passes that through as a `ConnectionErrorPayload`. A tool error
 * without one (a server that speaks no profile) and protocol failures are
 * mapped onto the nearest code, never dropped.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ConnectionErrorPayload } from '@noetic-tools/types';
import { ConnectionErrorPayloadSchema, NoeticErrorImpl } from '@noetic-tools/types';
import { toolResultText } from './content';
import type { ToolResult } from './wire';

//#region Helpers

function withCandidates(payload: ConnectionErrorPayload): ConnectionErrorPayload {
  if (payload.code !== 'ambiguous' || Array.isArray(payload.details?.candidates)) {
    return payload;
  }
  return {
    ...payload,
    details: {
      ...(payload.details ?? {}),
      candidates: [],
    },
  };
}

//#endregion

//#region Public API

/** @public Builds a `ConnectionErrorPayload`. */
export function connectionError(
  code: ConnectionErrorPayload['code'],
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ConnectionErrorPayload {
  return {
    code,
    message,
    ...(details === undefined
      ? {}
      : {
          details,
        }),
  };
}

/**
 * @public
 * The `ConnectionErrorPayload` of a tool error. A structured payload is used
 * as sent (an `ambiguous` one always carries a `details.candidates` list); an
 * unstructured error is `unavailable`, with the server's text as the message
 * and its content under `details.content`.
 */
export function toolErrorPayload(result: ToolResult): ConnectionErrorPayload {
  const parsed = ConnectionErrorPayloadSchema.safeParse(result.structuredContent);
  if (parsed.success) {
    return withCandidates(parsed.data);
  }
  const text = toolResultText(result);
  return connectionError('unavailable', text === '' ? 'The server reported an error.' : text, {
    content: result.content ?? [],
  });
}

/**
 * @public
 * The `ConnectionErrorPayload` of a failed request: invalid params are
 * `malformed`, an unknown method is `undeclared`, everything else (timeouts,
 * a closed connection, internal errors) is `unavailable`.
 */
export function requestErrorPayload(error: unknown): ConnectionErrorPayload {
  if (error instanceof McpError) {
    if (error.code === ErrorCode.InvalidParams) {
      return connectionError('malformed', error.message);
    }
    if (error.code === ErrorCode.MethodNotFound) {
      return connectionError('undeclared', error.message);
    }
    return connectionError('unavailable', error.message);
  }
  return connectionError('unavailable', error instanceof Error ? error.message : String(error));
}

/** @public A `connection_unavailable` NoeticError. */
export function unavailable(connection: string, reason: string): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'connection_unavailable',
    connection,
    reason,
  });
}

/** @public Rethrows the signal's reason when it is aborted. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
  }
}

//#endregion
