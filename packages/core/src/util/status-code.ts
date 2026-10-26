/** The HTTP status an SDK error carries, when it carries one. */
export function statusOf(e: unknown): number | undefined {
  if (typeof e !== 'object' || e === null || !('statusCode' in e)) {
    return undefined;
  }
  return typeof e.statusCode === 'number' ? e.statusCode : undefined;
}

/**
 * Whether the provider answered with an error status, so it generated and billed
 * nothing. A 2xx whose body failed to parse also carries a status, but was billed.
 */
export function isErrorStatus(e: unknown): boolean {
  const status = statusOf(e);
  return status !== undefined && status >= 400;
}
