/** The HTTP status an SDK error carries, when it carries one. */
export function statusOf(e: unknown): number | undefined {
  if (typeof e !== 'object' || e === null || !('statusCode' in e)) {
    return undefined;
  }
  return typeof e.statusCode === 'number' ? e.statusCode : undefined;
}
