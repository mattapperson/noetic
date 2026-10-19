/** JSON-RPC peers can reject with plain objects rather than Error instances. */
export function errorMessage(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) {
    return String(cause);
  }
  const message =
    'message' in cause && typeof cause.message === 'string' ? cause.message : undefined;
  const data = 'data' in cause ? cause.data : undefined;
  const detail =
    typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string'
      ? data.message
      : undefined;
  if (detail && detail !== message) {
    return message ? `${message}: ${detail}` : detail;
  }
  return message ?? 'Unknown error';
}
