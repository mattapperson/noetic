/**
 * What `mcp()` accepts: ACP's `McpServer` shape — a stdio server or an HTTP /
 * SSE endpoint, headers and environment as `[{ name, value }]` — or a
 * transport factory (for in-process servers and hosts that own the
 * transport), with the bridge options beside them: auth, spawn, webhooks, a
 * profile catalog, and timeouts. Validated with zod at the boundary.
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AnyExtension, AnyProfile, McpNamedValue, Spawn } from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import type { McpWebhooks } from './webhooks';

//#region Types

/** @public `fetch`, as the HTTP transports call it. */
export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * @public
 * A server launched as a subprocess speaking MCP over stdio: ACP's stdio
 * `McpServer`, which carries no `type` (`'stdio'` is accepted too).
 */
export interface McpStdioServer {
  readonly type?: 'stdio';
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  /**
   * Added to the SDK's default environment (`HOME`, `LOGNAME`, `PATH`,
   * `SHELL`, `TERM`, `USER`), never to the rest of this process's. With
   * `spawn` it is passed as is, and the machine adds it to that same list of
   * its own (`localMachine()` and `noetic-acp serve` do).
   */
  readonly env?: ReadonlyArray<McpNamedValue>;
  readonly cwd?: string;
  /**
   * Starts the server somewhere other than this process — the machine an ACP
   * agent runs on (`AcpAgent.spawn`, `spawnOn(machine)` from
   * `@noetic-tools/acp`), a container — and returns its stdio. Without it the
   * server is a local subprocess.
   */
  readonly spawn?: Spawn;
}

/**
 * @public
 * How the bridge signs in to a remote server.
 *
 * - `bearer`: a static token, sent as `Authorization: Bearer <token>`.
 * - `oauth`: an MCP SDK `OAuthClientProvider`. The SDK transport reads its
 *   tokens, and on a 401 runs discovery (`WWW-Authenticate`, protected-resource
 *   and authorization-server metadata), refresh or authorization through it.
 *
 * Either way the credential goes to the server's origin only (never across a
 * redirect to another origin) and is registered with the harness so it is
 * scrubbed from outputs, events and traces like a resolved secret.
 */
export type McpAuth =
  | {
      readonly kind: 'bearer';
      readonly token: string;
    }
  | {
      readonly kind: 'oauth';
      readonly provider: OAuthClientProvider;
    };

/**
 * @public
 * A remote server: ACP's `http` or `sse` `McpServer`. `'sse'` is the
 * deprecated 2024-11-05 transport.
 */
export interface McpHttpServer {
  readonly type: 'http' | 'sse';
  readonly url: string | URL;
  /** Sent to the configured origin only; never forwarded across a redirect to another origin. */
  readonly headers?: ReadonlyArray<McpNamedValue>;
  readonly fetch?: McpFetch;
  /** How to sign in, instead of an `Authorization` header (the two are refused together). */
  readonly auth?: McpAuth;
}

/** @public A server reached through a transport the caller builds (an in-process server, a custom channel). */
export interface McpTransportServer {
  /** Called once per MCP session. */
  readonly transport: () => Transport | Promise<Transport>;
}

/** @public Where the server is. */
export type McpServerTarget = McpStdioServer | McpHttpServer | McpTransportServer;

/** @public Bridge options. */
export interface McpOptions {
  /**
   * The connection name. It names the entry in a list of connections
   * (`connections: [mcp({ name: 'linear', … })]`) and must agree with a record
   * key that names it too.
   */
  readonly name?: string;
  /** Lets the server deliver events by webhook (`events/subscribe`). */
  readonly webhooks?: McpWebhooks;
  /**
   * Profile definitions the bridge checks a declaring server against. Without
   * them, a declaration is checked for internal consistency only and manifest
   * parts carry no profile flags (`eager`, `effects`, …).
   */
  readonly profiles?: ReadonlyArray<AnyProfile>;
  /** Extension definitions, likewise. */
  readonly extensions?: ReadonlyArray<AnyExtension>;
  /** Budget for start, handshake and capability discovery. Default 1e4 ms. */
  readonly timeoutMs?: number;
  /** Per-request timeout. Default 6e4 ms (the SDK default). */
  readonly requestTimeoutMs?: number;
  /** Interval between `events/poll` and `tasks/get` requests when the server suggests none. Default 1e3 ms. */
  readonly pollIntervalMs?: number;
  /** Sent in `initialize`. */
  readonly clientInfo?: {
    readonly name: string;
    readonly version: string;
  };
}

/**
 * @public
 * `mcp()`'s argument: where the server is, in ACP's `McpServer` shape (or a
 * caller-built transport), with the bridge options beside it. An ACP
 * `McpServer` is one as it stands.
 */
export type McpConfig = McpServerTarget & McpOptions;

/** @public A validated, normalized configuration. */
export interface ResolvedMcpConfig {
  readonly target: McpServerTarget;
  readonly options: McpOptions;
}

//#endregion

//#region Constants

/** @public Default budget for start, handshake and discovery. */
export const DEFAULT_MCP_TIMEOUT_MS = 1e4;

/** @public Default interval between polls. */
export const DEFAULT_POLL_INTERVAL_MS = 1e3;

/** @public Default per-request timeout. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 6e4;

//#endregion

//#region Schemas

const OptionsShape = {
  name: z.string().min(1).optional(),
  webhooks: z.custom<McpWebhooks>((v) => typeof v === 'object' && v !== null).optional(),
  profiles: z.array(z.custom<AnyProfile>((v) => isKind(v, 'profile'))).optional(),
  extensions: z.array(z.custom<AnyExtension>((v) => isKind(v, 'extension'))).optional(),
  timeoutMs: z.number().positive().optional(),
  requestTimeoutMs: z.number().positive().optional(),
  pollIntervalMs: z.number().positive().optional(),
  clientInfo: z
    .object({
      name: z.string().min(1),
      version: z.string().min(1),
    })
    .optional(),
  /** ACP's extension point; the bridge ignores it. */
  _meta: z.record(z.string(), z.unknown()).optional(),
} as const;

const NamedValueSchema = z
  .object({
    name: z.string().min(1),
    value: z.string(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const StdioSchema = z
  .object({
    ...OptionsShape,
    type: z.literal('stdio').optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.array(NamedValueSchema).optional(),
    cwd: z.string().min(1).optional(),
    spawn: z.custom<Spawn>((v) => typeof v === 'function').optional(),
  })
  .strict();

const HttpSchema = z
  .object({
    ...OptionsShape,
    type: z.enum([
      'http',
      'sse',
    ]),
    url: z.union([
      z.string().url(),
      z.instanceof(URL),
    ]),
    headers: z.array(NamedValueSchema).optional(),
    fetch: z.custom<McpFetch>((v) => typeof v === 'function').optional(),
    auth: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('bearer'),
          token: z.string().min(1),
        }),
        z.object({
          kind: z.literal('oauth'),
          provider: z.custom<OAuthClientProvider>(isOAuthClientProvider, {
            message:
              'expected an OAuthClientProvider (tokens(), clientInformation(), saveTokens(), …)',
          }),
        }),
      ])
      .optional(),
  })
  .strict();

const TransportSchema = z
  .object({
    ...OptionsShape,
    transport: z.custom<() => Transport | Promise<Transport>>((v) => typeof v === 'function'),
  })
  .strict();

const SHAPE_HINT =
  "Pass ACP's McpServer shape: { name, type: 'http' | 'sse', url, headers?: [{ name, value }] } or { name, command, args?, env?: [{ name, value }] }, or { transport }.";

//#endregion

//#region Helpers

function isKind(value: unknown, kind: string): boolean {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === kind;
}

const OAUTH_PROVIDER_METHODS = [
  'tokens',
  'saveTokens',
  'clientInformation',
  'redirectToAuthorization',
  'saveCodeVerifier',
  'codeVerifier',
] as const;

/** Whether `value` has the methods every `OAuthClientProvider` implements (class instances included). */
function isOAuthClientProvider(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    OAUTH_PROVIDER_METHODS.every((name) => typeof Reflect.get(value, name) === 'function')
  );
}

function invalid(message: string, hint: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'CONNECTION_INVALID',
    message,
    hint,
  });
}

/**
 * The first name given twice. Header names are compared without case, as
 * HTTP compares them; environment variable names exactly.
 */
function repeatedName(
  values: ReadonlyArray<McpNamedValue>,
  fold: (name: string) => string,
): string | undefined {
  const seen = new Set<string>();
  for (const { name } of values) {
    if (seen.has(fold(name))) {
      return name;
    }
    seen.add(fold(name));
  }
  return undefined;
}

function checkNames(
  values: ReadonlyArray<McpNamedValue> | undefined,
  what: 'header' | 'environment variable',
): void {
  const repeated = repeatedName(
    values ?? [],
    what === 'header' ? (name) => name.toLowerCase() : (name) => name,
  );
  if (repeated !== undefined) {
    throw invalid(`mcp() was given ${what} '${repeated}' twice.`, `Give each ${what} once.`);
  }
}

/**
 * Splits the validated config into where the server is and the bridge
 * options. ACP's `_meta` is dropped.
 */
function split<
  T extends McpOptions & {
    readonly _meta?: unknown;
  },
>(
  parsed: T,
): {
  readonly target: Omit<T, keyof McpOptions | '_meta'>;
  readonly options: McpOptions;
} {
  const {
    name,
    webhooks,
    profiles,
    extensions,
    timeoutMs,
    requestTimeoutMs,
    pollIntervalMs,
    clientInfo,
    _meta,
    ...target
  } = parsed;
  const options: McpOptions = {
    name,
    webhooks,
    profiles,
    extensions,
    timeoutMs,
    requestTimeoutMs,
    pollIntervalMs,
    clientInfo,
  };
  return {
    target,
    options: Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  };
}

/**
 * Validates the config against the schema its shape picks.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` when it does not parse.
 */
function parseConfig(config: McpConfig): ResolvedMcpConfig {
  if ('transport' in config) {
    return split(parseWith(TransportSchema, config));
  }
  if ('url' in config) {
    return split(parseWith(HttpSchema, config));
  }
  return split(parseWith(StdioSchema, config));
}

function parseWith<T>(schema: z.ZodType<T>, config: McpConfig): T {
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    throw invalid(`mcp() configuration is malformed: ${describeIssues(parsed.error)}`, SHAPE_HINT);
  }
  return parsed.data;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

//#endregion

//#region Public API

/**
 * @public
 * Validates `mcp()`'s argument and splits it into where the server is and the
 * bridge options.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` when the configuration is
 *   malformed, names a header or environment variable twice, or gives both
 *   `auth` and an `Authorization` header.
 */
export function resolveMcpConfig(config: McpConfig): ResolvedMcpConfig {
  if (typeof config !== 'object' || config === null) {
    throw invalid('mcp() needs a server object.', SHAPE_HINT);
  }
  const resolved = parseConfig(config);
  const { target } = resolved;
  if (isHttpTarget(target)) {
    checkNames(target.headers, 'header');
    const authorization = (target.headers ?? []).some(
      (header) => header.name.toLowerCase() === 'authorization',
    );
    if (target.auth !== undefined && authorization) {
      throw invalid(
        'mcp() was given both `auth` and an `Authorization` header.',
        'Pass the credential once: as the `Authorization` header, or as `auth`.',
      );
    }
  }
  if (isStdioTarget(target)) {
    checkNames(target.env, 'environment variable');
  }
  return resolved;
}

/** @public Whether the target is launched as a subprocess (each session is its own process). */
export function isStdioTarget(target: McpServerTarget): target is McpStdioServer {
  return 'command' in target;
}

/** @public Whether the target is reached through a caller-built transport. */
export function isTransportTarget(target: McpServerTarget): target is McpTransportServer {
  return 'transport' in target;
}

/** Whether the target is a remote server. */
export function isHttpTarget(target: McpServerTarget): target is McpHttpServer {
  return 'url' in target;
}

/** Headers or environment variables as the record the SDK transports take. */
export function namedRecord(
  values: ReadonlyArray<McpNamedValue> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    (values ?? []).map(({ name, value }) => [
      name,
      value,
    ]),
  );
}

//#endregion
