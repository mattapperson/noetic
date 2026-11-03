/**
 * The URL patterns of a host's `mcp` allowlist (spec 26 § MCP servers). A
 * pattern is matched part by part — scheme, host, port, then path — so a `*`
 * can never stand for a `/`, `?`, `#` or `@` that moves the URL to another
 * host: `https://*.example.com/*` does not match
 * `https://evil.com/.example.com/`.
 */

import { NoeticConfigError } from '@noetic-tools/types';
import { globMatches } from './workflow-connections';

//#region Types

interface UrlPattern {
  /** `http:` or `https:`, as `URL.protocol` writes it. */
  readonly scheme: string;
  /** Lowercase, as `URL.hostname` writes it. */
  readonly host: string;
  /** Whether the pattern began `*.`: any subdomain of `host`, not `host` itself. */
  readonly subdomains: boolean;
  /** `*`, or the port as `URL.port` writes it (`''` for the scheme's default). */
  readonly port: string;
  /** A `*` glob over `URL.pathname`. */
  readonly path: string;
}

//#endregion

//#region Public API

/**
 * Whether `url` matches the host's pattern.
 *
 * @throws `NoeticConfigError` `CONNECTION_INVALID` when the pattern is not `<scheme>://<host>[:<port>]<path>` with `*` only as a leading host label, the port, or in the path.
 */
export function urlPatternMatches(pattern: string, url: URL): boolean {
  const parts = parsePattern(pattern);
  if (url.protocol !== parts.scheme) {
    return false;
  }
  if (!hostMatches(parts, url.hostname)) {
    return false;
  }
  if (parts.port !== '*' && url.port !== parts.port) {
    return false;
  }
  return globMatches(parts.path, url.pathname);
}

//#endregion

//#region Parsing

const PATTERN =
  /^(https?):\/\/(\*\.)?(\[[0-9A-Fa-f:.]+\]|[^/:?#*@\\[\]]+)(?::(\d+|\*))?(\/[^?#]*)?$/;

function parsePattern(pattern: string): UrlPattern {
  const match = PATTERN.exec(pattern);
  const [, scheme, wildcard, host, port, path] = match ?? [];
  if (!scheme || !host) {
    throw invalid(pattern);
  }
  // Read the host and port back through `URL`, so the pattern is normalized
  // exactly as the URLs it is matched against: lowercase, punycode, and the
  // scheme's default port dropped.
  const origin = `${scheme}://${host}${port && port !== '*' ? `:${port}` : ''}/`;
  if (!URL.canParse(origin)) {
    throw invalid(pattern);
  }
  const parsed = new URL(origin);
  return {
    scheme: parsed.protocol,
    host: parsed.hostname,
    subdomains: wildcard !== undefined,
    port: port === '*' ? '*' : parsed.port,
    path: new URL(path ?? '/', parsed).pathname,
  };
}

function hostMatches(pattern: UrlPattern, hostname: string): boolean {
  if (!pattern.subdomains) {
    return hostname === pattern.host;
  }
  return hostname.endsWith(`.${pattern.host}`);
}

function invalid(pattern: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'CONNECTION_INVALID',
    message: `The host's mcp allowlist has URL pattern ${JSON.stringify(pattern)}, which is not <scheme>://<host>[:<port>]<path>.`,
    hint: 'Use http or https, a host that may start with `*.`, a port number or `*`, and a path where `*` matches any run of characters, e.g. https://*.example.com/mcp/*.',
  });
}

//#endregion
