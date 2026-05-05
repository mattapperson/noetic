/**
 * Portable `fileURLToPath`. Handles POSIX `file:///abs/path` and Windows
 * `file:///C:/abs/path`; non-file URLs (e.g. bundled `bun://…`) round-trip
 * as `url.href` since there's nothing meaningful on disk to return.
 */
export function fileUrlToPath(url: URL | string): string {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  if (parsed.protocol !== 'file:') {
    return parsed.href;
  }
  const pathname = decodeURIComponent(parsed.pathname);
  if (/^\/[A-Za-z]:\//.test(pathname)) {
    return pathname.slice(1);
  }
  return pathname;
}
