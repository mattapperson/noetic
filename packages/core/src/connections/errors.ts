/**
 * Error constructors for the connection runtime (spec 35 § Errors). Setup and
 * validation problems are `NoeticConfigError`s with a `CONNECTION_*` code; run
 * time problems are `NoeticErrorImpl`s with a `connection_*` kind, or
 * `steering_denied` when a gate refused.
 */

import type { ConnectionErrorPayload, ConnectionInputRequest } from '@noetic-tools/types';
import { ConnectionConfigErrorCode, NoeticConfigError, NoeticErrorImpl } from '@noetic-tools/types';

//#region Config errors

/** `CONNECTION_UNKNOWN`: a handle, node, trigger or allowlist names a connection the harness does not have. */
export function unknownConnectionError(
  name: string,
  known: ReadonlyArray<string>,
): NoeticConfigError {
  const list = known.length > 0 ? known.join(', ') : '(none)';
  return new NoeticConfigError({
    code: ConnectionConfigErrorCode.Unknown,
    message: `The harness has no connection named '${name}'. Known: ${list}.`,
    hint: `Add '${name}' to the harness \`connections\`, or point the handle at an existing one with \`from\`.`,
  });
}

/** `CONNECTION_INVALID`: a manifest entry, handle or harness entry is malformed. */
export function invalidConnectionError(message: string, hint: string): NoeticConfigError {
  return new NoeticConfigError({
    code: ConnectionConfigErrorCode.Invalid,
    message,
    hint,
  });
}

/** `CONNECTION_NOT_ALLOWED`: a request asks for more than it is granted, or sets a host-only setup field. */
export function notAllowedConnectionError(message: string, hint: string): NoeticConfigError {
  return new NoeticConfigError({
    code: ConnectionConfigErrorCode.NotAllowed,
    message,
    hint,
  });
}

/** `CONNECTION_TOOL_COLLISION`: two operations would reach the model under one tool name. */
export function toolCollisionError(
  toolName: string,
  first: string,
  second: string,
): NoeticConfigError {
  return new NoeticConfigError({
    code: ConnectionConfigErrorCode.ToolCollision,
    message: `Tool name '${toolName}' would be used by both ${first} and ${second}.`,
    hint: "Rename one connection, or set `expose: 'none'` (or `'eager'`) on one of them.",
  });
}

//#endregion

//#region Run-time errors

/** `connection_unavailable`. */
export function unavailableError(connection: string, reason: string): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'connection_unavailable',
    connection,
    reason,
  });
}

/** `connection_failed`. */
export function failedError(
  connection: string,
  op: string,
  error: ConnectionErrorPayload,
): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'connection_failed',
    connection,
    op,
    error,
  });
}

/** `connection_ref_invalid`. */
export function refInvalidError(connection: string, reason: string): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'connection_ref_invalid',
    connection,
    reason,
  });
}

/** `connection_secret_refused`. */
export function secretRefusedError(connection: string, op: string): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'connection_secret_refused',
    connection,
    op,
  });
}

/** `connection_input_required`. */
export function inputRequiredError(
  connection: string,
  request: ConnectionInputRequest,
): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'connection_input_required',
    connection,
    request,
  });
}

/** `connection_resume_refused`. */
export function resumeRefusedError(connection: string, reason: string): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'connection_resume_refused',
    connection,
    reason,
  });
}

/** `steering_denied`: a gate refused the call. */
export function deniedError(guidance: string): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'steering_denied',
    guidance,
  });
}

//#endregion
