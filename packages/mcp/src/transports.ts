/**
 * Building the MCP transport for a target: stdio subprocess, Streamable HTTP,
 * the deprecated HTTP+SSE transport (loaded only when asked for), or a
 * caller-built transport.
 *
 * Configured HTTP headers and credentials never reach another origin. Plain
 * `fetch` re-sends custom headers to the redirect target; the origin-aware
 * fetch below follows redirects manually and drops the configured headers —
 * and `Authorization`, however it was set — when the origin changes, as Agent
 * Plugins §7.2.1 requires. It also drops the configured headers from a request
 * the SDK sends straight to another origin (OAuth metadata and token
 * endpoints), which keep only the credentials the SDK sets for them.
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpAuth, McpFetch, McpHttpServer, McpServerTarget, McpStdioServer } from './config';
import { isStdioTarget, isTransportTarget, namedRecord } from './config';
import type { HttpTransportOptions } from './sse-transport';
import { createSseTransport } from './sse-transport';
import { SpawnedTransport } from './stream-transport';

//#region Origin-aware fetch

/** Redirect hops to follow before giving up, matching the fetch default. */
const MAX_REDIRECTS = 20;

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400 && response.headers.has('location');
}

function becomesGet(status: number, method: string | undefined): boolean {
  return status === 303 || ((status === 301 || status === 302) && method === 'POST');
}

function withoutHeaders(headers: Headers, names: ReadonlyArray<string>): Headers {
  const stripped = new Headers(headers);
  for (const name of names) {
    stripped.delete(name);
  }
  return stripped;
}

/**
 * @public
 * A `fetch` that keeps credentials on their origin. `configured` headers are
 * dropped from a request sent to an origin other than `origin` (the SDK's
 * OAuth metadata and token requests), and — with `Authorization`, however it
 * was set — from any redirect that leaves the request's own origin.
 * Same-origin redirects keep them; a 303 (or a 301/302 on a POST) becomes a
 * bodyless GET. Without `origin`, only redirects are checked.
 */
export function originAwareFetch(
  configured: Readonly<Record<string, string>>,
  base: McpFetch = fetch,
  origin?: string | URL,
): McpFetch {
  const configuredNames = Object.keys(configured).map((name) => name.toLowerCase());
  const redirectNames = [
    ...new Set([
      'authorization',
      ...configuredNames,
    ]),
  ];
  const home = origin === undefined ? undefined : new URL(origin).origin;
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    let url = new URL(input);
    const requestOrigin = url.origin;
    let headers = new Headers(init?.headers);
    if (home !== undefined && requestOrigin !== home) {
      headers = withoutHeaders(headers, configuredNames);
    }
    const request: RequestInit = {
      ...init,
    };
    for (let hop = 0; ; hop++) {
      const response = await base(url, {
        ...request,
        headers,
        redirect: 'manual',
      });
      if (!isRedirect(response) || hop >= MAX_REDIRECTS) {
        return response;
      }
      url = new URL(response.headers.get('location') ?? '', url);
      if (url.origin !== requestOrigin) {
        headers = withoutHeaders(headers, redirectNames);
      }
      if (becomesGet(response.status, request.method)) {
        request.method = 'GET';
        request.body = undefined;
      }
    }
  };
}

//#endregion

//#region Credentials

/** @public What the transport is given besides its target. */
export interface TransportHooks {
  /** Registers a credential so the harness scrubs it (`ConnectOptions.redact`). */
  readonly redact?: (value: string) => void;
}

function redactTokens(
  tokens: Awaited<ReturnType<OAuthClientProvider['tokens']>>,
  redact: (value: string) => void,
): void {
  if (tokens === undefined) {
    return;
  }
  redact(tokens.access_token);
  if (tokens.refresh_token !== undefined) {
    redact(tokens.refresh_token);
  }
}

/**
 * An `OAuthClientProvider` that registers every token it hands out or is
 * given with `redact`, and otherwise is `provider` itself (methods are bound
 * to it, so class instances with private state keep working).
 */
function redactingProvider(
  provider: OAuthClientProvider,
  redact: (value: string) => void,
): OAuthClientProvider {
  return new Proxy(provider, {
    get(target, property): unknown {
      if (property === 'tokens') {
        return async () => {
          const tokens = await target.tokens();
          redactTokens(tokens, redact);
          return tokens;
        };
      }
      if (property === 'saveTokens') {
        return (tokens: Parameters<OAuthClientProvider['saveTokens']>[0]) => {
          redactTokens(tokens, redact);
          return target.saveTokens(tokens);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The `Authorization` header for a bearer token, and the SDK auth provider for OAuth. */
function credentials(
  auth: McpAuth | undefined,
  hooks: TransportHooks,
): {
  readonly headers: Readonly<Record<string, string>>;
  readonly authProvider?: OAuthClientProvider;
} {
  if (auth === undefined) {
    return {
      headers: {},
    };
  }
  if (auth.kind === 'bearer') {
    hooks.redact?.(auth.token);
    return {
      headers: {
        Authorization: `Bearer ${auth.token}`,
      },
    };
  }
  return {
    headers: {},
    authProvider:
      hooks.redact === undefined ? auth.provider : redactingProvider(auth.provider, hooks.redact),
  };
}

/**
 * The shortest configured value registered for scrubbing. Below it sit flags
 * and words (`1`, `true`, `json`, `debug`), not credentials, and scrubbing
 * every occurrence of those would turn ordinary output into `<redacted>`.
 */
const MIN_SCRUBBED_LENGTH = 8;

/**
 * An absolute path or path list (`/usr/bin:/bin`, `C:\Tools;D:\Bin`). Env
 * carries these (`PATH`, `HOME`, a plugin's root) and servers echo paths
 * under them in nearly every result, so scrubbing them would hide every file
 * a server names. A base64 token can match only if it opens with `/` and
 * holds no `+` or `=`.
 */
const PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/])[\w.\-~ /\\:;]*$/;

/**
 * Registers with `redact` every configured value that may carry a credential:
 * header values, the URL's userinfo and query values, and stdio env values.
 * The bridge cannot tell which of them are secret, so it registers them all
 * but short values and paths (see `MIN_SCRUBBED_LENGTH`, `PATH_PATTERN`). An
 * `Authorization` header is a credential at any length, and its bearer token
 * is registered alone too, as an `auth` token is.
 */
function redactConfigured(
  target: McpStdioServer | McpHttpServer,
  redact: (value: string) => void,
): void {
  const add = (value: string): void => {
    if (value.length >= MIN_SCRUBBED_LENGTH && !PATH_PATTERN.test(value)) {
      redact(value);
    }
  };
  if (isStdioTarget(target)) {
    for (const { value } of target.env ?? []) {
      add(value);
    }
    return;
  }
  for (const { name, value } of target.headers ?? []) {
    if (name.toLowerCase() !== 'authorization') {
      add(value);
      continue;
    }
    redact(value);
    const token = /^Bearer\s+(.+)$/i.exec(value)?.[1];
    if (token !== undefined) {
      redact(token);
    }
  }
  const url = new URL(target.url);
  for (const part of new Set([
    url.username,
    url.password,
    decoded(url.username),
    decoded(url.password),
  ])) {
    add(part);
  }
  for (const value of url.searchParams.values()) {
    add(value);
  }
}

/** `text` percent-decoded; the URL parser leaves a stray `%` as is, which `decodeURIComponent` refuses. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

//#endregion

//#region Public API

async function createHttpTransport(
  target: McpHttpServer,
  hooks: TransportHooks,
): Promise<Transport> {
  const url = new URL(target.url);
  const signIn = credentials(target.auth, hooks);
  const headers = {
    ...namedRecord(target.headers),
    ...signIn.headers,
  };
  const options: HttpTransportOptions = {
    fetch: originAwareFetch(headers, target.fetch, url),
    ...(Object.keys(headers).length === 0
      ? {}
      : {
          requestInit: {
            headers,
          },
        }),
    ...(signIn.authProvider === undefined
      ? {}
      : {
          authProvider: signIn.authProvider,
        }),
  };
  if (target.type === 'sse') {
    return createSseTransport(url, options);
  }
  return new StreamableHTTPClientTransport(url, options);
}

/** @public Builds a fresh transport for one MCP session. */
export async function createTransport(
  target: McpServerTarget,
  hooks: TransportHooks = {},
): Promise<Transport> {
  if (isTransportTarget(target)) {
    return target.transport();
  }
  if (hooks.redact !== undefined) {
    redactConfigured(target, hooks.redact);
  }
  if (isStdioTarget(target) && target.spawn) {
    return new SpawnedTransport(target.spawn, {
      command: target.command,
      ...(target.args === undefined
        ? {}
        : {
            args: target.args,
          }),
      ...(target.env === undefined
        ? {}
        : {
            env: namedRecord(target.env),
          }),
      ...(target.cwd === undefined
        ? {}
        : {
            cwd: target.cwd,
          }),
    });
  }
  if (isStdioTarget(target)) {
    return new StdioClientTransport({
      command: target.command,
      args: [
        ...(target.args ?? []),
      ],
      ...(target.env === undefined
        ? {}
        : {
            env: namedRecord(target.env),
          }),
      ...(target.cwd === undefined
        ? {}
        : {
            cwd: target.cwd,
          }),
    });
  }
  return createHttpTransport(target, hooks);
}

//#endregion
