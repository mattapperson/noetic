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
  const rawMessage = Reflect.get(cause, 'message');
  const message = typeof rawMessage === 'string' && rawMessage.length > 0 ? rawMessage : undefined;
  const code = Reflect.get(cause, 'code');
  const detail = detailOf(Reflect.get(cause, 'data'));
  const head = message ?? (detail === undefined ? safeJson(cause) : undefined);
  const parts = [
    head,
    detail !== undefined && detail !== message ? detail : undefined,
  ].filter((part): part is string => part !== undefined);
  const text = parts.join(': ');
  return typeof code === 'number' ? `${text} (${code})` : text;
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

/** Whether a thrown value is a JSON-RPC error: it carries a numeric `code` or a `data` payload. */
export function isRpcError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) {
    return false;
  }
  return typeof Reflect.get(cause, 'code') === 'number' || Reflect.get(cause, 'data') !== undefined;
}
