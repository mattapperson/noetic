/**
 * What `mcp()` accepts: a command line, a stdio server, an HTTP endpoint, or a
 * transport factory (for in-process servers and hosts that own the
 * transport), plus the bridge options — webhooks, a profile catalog, and
 * timeouts. Validated with zod at the boundary.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AnyExtension, AnyProfile } from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import type { McpWebhooks } from './webhooks';

//#region Types

/** @public `fetch`, as the HTTP transports call it. */
export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** @public A server launched as a subprocess speaking MCP over stdio. */
export interface McpStdioServer {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  /** Added to the SDK's default environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** @public A remote server. */
export interface McpHttpServer {
  readonly url: string | URL;
  /** Sent to the configured origin only; never forwarded across a redirect to another origin. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Default `'streamable-http'`; `'sse'` is the deprecated 2024-11-05 transport. */
  readonly protocol?: 'streamable-http' | 'sse';
  readonly fetch?: McpFetch;
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

/** @public `mcp()`'s argument: a command line, or a target with options. */
export type McpConfig = string | (McpServerTarget & McpOptions);

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
} as const;

const StdioSchema = z.object({
  ...OptionsShape,
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1).optional(),
});

const HttpSchema = z.object({
  ...OptionsShape,
  url: z.union([
    z.string().url(),
    z.instanceof(URL),
  ]),
  headers: z.record(z.string(), z.string()).optional(),
  protocol: z
    .enum([
      'streamable-http',
      'sse',
    ])
    .optional(),
  fetch: z.custom<McpFetch>((v) => typeof v === 'function').optional(),
});

const TransportSchema = z.object({
  ...OptionsShape,
  transport: z.custom<() => Transport | Promise<Transport>>((v) => typeof v === 'function'),
});

//#endregion

//#region Helpers

function isKind(value: unknown, kind: string): boolean {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === kind;
}

function invalid(message: string, hint: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'CONNECTION_INVALID',
    message,
    hint,
  });
}

/**
 * @public
 * Splits a command line into words, honoring single quotes, double quotes and
 * backslash escapes. No variable expansion, no globbing.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` for an empty line or an unclosed quote.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
        continue;
      }
      if (ch === '\\' && quote === '"' && i + 1 < line.length) {
        i++;
        current += line.charAt(i);
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      i++;
      current += line.charAt(i);
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) {
        words.push(current);
      }
      current = '';
      inWord = false;
      continue;
    }
    current += ch;
    inWord = true;
  }
  if (quote !== undefined) {
    throw invalid(`mcp() command line has an unclosed ${quote} quote.`, 'Close the quote.');
  }
  if (inWord) {
    words.push(current);
  }
  if (words.length === 0) {
    throw invalid(
      'mcp() needs a command line, a server object or a URL.',
      "Pass e.g. mcp('npx @playwright/mcp@latest').",
    );
  }
  return words;
}

function pickOptions(input: McpOptions): McpOptions {
  return {
    ...(input.webhooks === undefined
      ? {}
      : {
          webhooks: input.webhooks,
        }),
    ...(input.profiles === undefined
      ? {}
      : {
          profiles: input.profiles,
        }),
    ...(input.extensions === undefined
      ? {}
      : {
          extensions: input.extensions,
        }),
    ...(input.timeoutMs === undefined
      ? {}
      : {
          timeoutMs: input.timeoutMs,
        }),
    ...(input.requestTimeoutMs === undefined
      ? {}
      : {
          requestTimeoutMs: input.requestTimeoutMs,
        }),
    ...(input.pollIntervalMs === undefined
      ? {}
      : {
          pollIntervalMs: input.pollIntervalMs,
        }),
    ...(input.clientInfo === undefined
      ? {}
      : {
          clientInfo: input.clientInfo,
        }),
  };
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
 * Validates and normalizes `mcp()`'s arguments. Options given separately
 * override those inside the target object.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` when the configuration is malformed.
 */
export function resolveMcpConfig(config: McpConfig, extra: McpOptions = {}): ResolvedMcpConfig {
  const extraParsed = z.object(OptionsShape).safeParse(extra);
  if (!extraParsed.success) {
    throw invalid(
      `mcp() options are malformed: ${describeIssues(extraParsed.error)}`,
      'Check the option names and types.',
    );
  }
  if (typeof config === 'string') {
    const [command, ...args] = splitCommandLine(config);
    return {
      target: {
        command: command ?? '',
        args,
      },
      options: pickOptions(extra),
    };
  }
  if (typeof config !== 'object' || config === null) {
    throw invalid(
      'mcp() needs a command line, a server object or a URL.',
      "Pass e.g. mcp('npx @playwright/mcp@latest') or mcp({ url }).",
    );
  }
  const schema =
    'transport' in config ? TransportSchema : 'url' in config ? HttpSchema : StdioSchema;
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    throw invalid(
      `mcp() configuration is malformed: ${describeIssues(parsed.error)}`,
      'Pass { command, args?, env?, cwd? }, { url, headers? } or { transport }.',
    );
  }
  const options = {
    ...pickOptions(config),
    ...pickOptions(extra),
  };
  if ('transport' in config) {
    return {
      target: {
        transport: config.transport,
      },
      options,
    };
  }
  if ('url' in config) {
    return {
      target: {
        url: config.url,
        ...(config.headers === undefined
          ? {}
          : {
              headers: config.headers,
            }),
        ...(config.protocol === undefined
          ? {}
          : {
              protocol: config.protocol,
            }),
        ...(config.fetch === undefined
          ? {}
          : {
              fetch: config.fetch,
            }),
      },
      options,
    };
  }
  return {
    target: {
      command: config.command,
      ...(config.args === undefined
        ? {}
        : {
            args: config.args,
          }),
      ...(config.env === undefined
        ? {}
        : {
            env: config.env,
          }),
      ...(config.cwd === undefined
        ? {}
        : {
            cwd: config.cwd,
          }),
    },
    options,
  };
}

/** @public Whether the target is launched as a subprocess (each session is its own process). */
export function isStdioTarget(target: McpServerTarget): target is McpStdioServer {
  return 'command' in target;
}

/** @public Whether the target is reached through a caller-built transport. */
export function isTransportTarget(target: McpServerTarget): target is McpTransportServer {
  return 'transport' in target;
}

//#endregion
