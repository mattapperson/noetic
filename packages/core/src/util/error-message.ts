/**
 * A readable message for anything thrown. JSON-RPC peers (an ACP agent) reject
 * with `{ code, message, data }` — as a plain object or as an `Error` carrying
 * `code`/`data` — and the useful part ("Authentication required") is often in
 * `data`, so it is appended rather than lost as `[object Object]` or a bare
 * "Internal error".
 */
export function errorMessage(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) {
    return String(cause);
  }
  if (!isRpcError(cause)) {
    const message = Reflect.get(cause, 'message');
    if (typeof message === 'string') {
      return message;
    }
    return safeJson(cause);
  }
  const rawMessage = Reflect.get(cause, 'message');
  const message = typeof rawMessage === 'string' && rawMessage.length > 0 ? rawMessage : undefined;
  const code = Reflect.get(cause, 'code');
  const detail = detailOf(Reflect.get(cause, 'data'));
  const parts = [
    message ?? (detail === undefined ? 'JSON-RPC error' : undefined),
    detail !== undefined && detail !== message ? detail : undefined,
  ].filter((part): part is string => part !== undefined);
  const text = parts.join(': ');
  return typeof code === 'number' ? `${text} (${code})` : text;
}

/**
 * The error a step fails with for a JSON-RPC rejection: the readable message,
 * keeping the rejection's `code` and `data` (and the original as `cause`) for
 * callers that branch on them, such as an auth-required code.
 */
export class RpcFailure extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(cause: unknown) {
    super(errorMessage(cause), {
      cause,
    });
    this.name = 'RpcFailure';
    const code =
      typeof cause === 'object' && cause !== null ? Reflect.get(cause, 'code') : undefined;
    this.code = typeof code === 'number' ? code : undefined;
    this.data =
      typeof cause === 'object' && cause !== null ? Reflect.get(cause, 'data') : undefined;
  }
}

/** The detail a JSON-RPC error's `data` carries: its message, its details, or the value itself. */
function detailOf(data: unknown): string | undefined {
  if (data === undefined || data === null) {
    return undefined;
  }
  if (typeof data === 'string') {
    return data;
  }
  if (typeof data !== 'object') {
    return String(data);
  }
  for (const key of [
    'message',
    'details',
  ]) {
    const value = Reflect.get(data, key);
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return safeJson(data);
}

const MAX_DETAIL_CHARS = 500;

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
  } catch {
    return String(value);
  }
}

/**
 * Whether a thrown value is a JSON-RPC error: it carries a numeric `code` or a
 * `data` payload. A `DOMException` (an AbortError, a TimeoutError) has a
 * numeric legacy `code` too, and is not one.
 */
export function isRpcError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) {
    return false;
  }
  if (typeof DOMException !== 'undefined' && cause instanceof DOMException) {
    return false;
  }
  return typeof Reflect.get(cause, 'code') === 'number' || Reflect.get(cause, 'data') !== undefined;
}
