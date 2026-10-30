/**
 * Webhook Receiver (spec 25 § Webhook Receiver, spec 35 § Events): an HTTP
 * endpoint host that `mcp({ webhooks })` registers with servers delivering
 * events by webhook (`events/subscribe`), and that in-process sources can use
 * for webhooks from the host's own app.
 *
 * Every delivery is verified before its handler runs: a Standard Webhooks
 * signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`), a
 * five-minute timestamp window, and duplicate ids dropped. Interpreting the
 * body (events, `gap` and `terminated` control messages) is the caller's job.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

//#region Constants

/** @public The Standard Webhooks timestamp tolerance: five minutes. */
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1e3;

/** @public Default cap on a delivery body (1 MiB). */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

const SECRET_PREFIX = 'whsec_';
const SIGNATURE_VERSION = 'v1';
const DEFAULT_PATH = '/webhooks';
const DEFAULT_HOSTNAME = '127.0.0.1';

const HttpStatus = {
  Accepted: 204,
  Duplicate: 200,
  BadRequest: 400,
  Unauthorized: 401,
  NotFound: 404,
  MethodNotAllowed: 405,
  Conflict: 409,
  TooLarge: 413,
  HandlerFailed: 500,
} as const;

//#endregion

//#region Types

/** @public Why a delivery failed verification. */
export type WebhookRejection = 'malformed' | 'stale' | 'signature';

/** @public The result of `verifyStandardWebhook`. */
export type WebhookVerification =
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly reason: WebhookRejection;
    };

/** @public Input to `signStandardWebhook`. */
export interface SignWebhookInput {
  /** `whsec_<base64>`, or bare base64. */
  readonly secret: string;
  readonly id: string;
  /** Seconds since the epoch. */
  readonly timestamp: number;
  readonly body: string;
}

/** @public Input to `verifyStandardWebhook`. */
export interface VerifyWebhookInput {
  readonly secret: string;
  readonly id: string | undefined;
  /** The raw `webhook-timestamp` header (seconds since the epoch). */
  readonly timestamp: string | undefined;
  /** The raw `webhook-signature` header: space-separated `v1,<base64>` entries. */
  readonly signature: string | undefined;
  readonly body: string;
  /** Epoch ms; defaults to `Date.now()`. */
  readonly now?: number;
  readonly toleranceMs?: number;
}

/** @public One verified delivery handed to a registered handler. */
export interface WebhookDelivery<TBody = unknown> {
  /** The `webhook-id`; unique per message, stable across retries. */
  readonly id: string;
  /** The `webhook-timestamp`, seconds since the epoch. */
  readonly timestamp: number;
  /** The JSON-parsed body. */
  readonly body: TBody;
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * @public
 * Handles a verified delivery. Throwing (or rejecting) answers 500 and forgets
 * the id, so the sender's retry is delivered again.
 */
export type WebhookHandler = (delivery: WebhookDelivery) => void | Promise<void>;

/** @public What a caller registers. */
export interface WebhookRegistration {
  readonly onDelivery: WebhookHandler;
  /** The signing secret to verify with; generated (`whsec_…`) when omitted. */
  readonly secret?: string;
  /** Unregisters the endpoint when aborted. */
  readonly signal?: AbortSignal;
}

/**
 * @public
 * A request handed through unverified, for a caller that verifies deliveries
 * itself — the `mcp({ webhooks })` receiver contract. Header names are lowercase.
 */
export interface RawWebhookRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** @public Handles a raw request and says which HTTP status to answer. */
export type RawWebhookHandler = (request: RawWebhookRequest) => Promise<{
  readonly status: number;
}>;

/** @public A registered endpoint: hand `url` and `secret` to the sender. */
export interface WebhookEndpoint {
  readonly id: string;
  readonly url: string;
  /** The signing secret the receiver verifies with; unused by a raw endpoint. */
  readonly secret: string;
  /** Unregisters the endpoint; later deliveries answer 404. */
  close(): Promise<void>;
}

/** @public The receiver passed to `mcp({ webhooks })`. */
export interface WebhookReceiver {
  /** Starts listening (idempotent); `register` calls it for you. */
  listen(): Promise<{
    readonly port: number;
  }>;
  /**
   * Opens an endpoint. With a registration, the receiver verifies each delivery
   * (signature, timestamp window, duplicate ids) before calling `onDelivery`.
   * With a bare handler — what `mcp({ webhooks })` passes — it hands every POST
   * through unverified (only method, size and endpoint are checked) and answers
   * with the status the handler returns, so the caller verifies with its own secret.
   */
  register(registration: WebhookRegistration | RawWebhookHandler): Promise<WebhookEndpoint>;
  /** Stops listening and drops every endpoint. */
  close(): Promise<void>;
}

/** @public Options for `createWebhookReceiver`. */
export interface CreateWebhookReceiverOptions {
  /** Port to listen on; `0` (the default) picks a free one. */
  readonly port?: number;
  /** The externally reachable base URL (behind a tunnel or proxy); defaults to the local address. */
  readonly publicUrl?: string;
  /** Interface to bind; defaults to `127.0.0.1`. Use `0.0.0.0` to accept remote senders directly. */
  readonly hostname?: string;
  /** Path prefix endpoints live under; defaults to `/webhooks`. */
  readonly path?: string;
  readonly maxBodyBytes?: number;
  readonly toleranceMs?: number;
  /** Clock override for tests (epoch ms). */
  readonly now?: () => number;
}

interface Endpoint {
  readonly id: string;
  readonly secret: string;
  readonly onDelivery: WebhookHandler;
  /** Set for a raw endpoint: deliveries go here unverified. */
  readonly raw?: RawWebhookHandler;
  /** id → epoch ms first accepted. */
  readonly seen: Map<string, number>;
  readonly inFlight: Set<string>;
}

interface ReceiverState {
  readonly endpoints: Map<string, Endpoint>;
  readonly prefix: string;
  readonly maxBodyBytes: number;
  readonly toleranceMs: number;
  readonly now: () => number;
}

type Reply = {
  readonly status: number;
  readonly body?: string;
};

//#endregion

//#region Signing

function secretKey(secret: string): Buffer {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const key = Buffer.from(encoded, 'base64');
  if (key.length === 0) {
    throw new TypeError('webhook secret must be non-empty base64 (optionally prefixed "whsec_")');
  }
  return key;
}

function signatureFor(key: Buffer, signed: string): Buffer {
  return createHmac('sha256', key).update(signed).digest();
}

function signedContent(id: string, timestamp: string, body: string): string {
  return `${id}.${timestamp}.${body}`;
}

function matchesAny(expected: Buffer, header: string): boolean {
  for (const entry of header.split(' ')) {
    const [version, encoded] = entry.split(',');
    if (version !== SIGNATURE_VERSION || !encoded) {
      continue;
    }
    const candidate = Buffer.from(encoded, 'base64');
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return true;
    }
  }
  return false;
}

/** @public A fresh `whsec_` signing secret. */
export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(24).toString('base64')}`;
}

/** @public The `webhook-signature` header value (`v1,<base64>`) for a delivery. */
export function signStandardWebhook(input: SignWebhookInput): string {
  const signed = signedContent(input.id, String(input.timestamp), input.body);
  return `${SIGNATURE_VERSION},${signatureFor(secretKey(input.secret), signed).toString('base64')}`;
}

/**
 * @public
 * Verifies a Standard Webhooks delivery: required headers present, timestamp
 * within the tolerance window (five minutes by default), and at least one
 * `v1` signature matching. Duplicate detection is the receiver's job.
 */
export function verifyStandardWebhook(input: VerifyWebhookInput): WebhookVerification {
  const { id, timestamp, signature } = input;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) {
    return {
      ok: false,
      reason: 'malformed',
    };
  }
  const now = input.now ?? Date.now();
  const tolerance = input.toleranceMs ?? WEBHOOK_TOLERANCE_MS;
  if (Math.abs(now - Number(timestamp) * 1e3) > tolerance) {
    return {
      ok: false,
      reason: 'stale',
    };
  }
  const expected = signatureFor(secretKey(input.secret), signedContent(id, timestamp, input.body));
  if (!matchesAny(expected, signature)) {
    return {
      ok: false,
      reason: 'signature',
    };
  }
  return {
    ok: true,
  };
}

//#endregion

//#region Request handling

const REJECTION_STATUS: Record<WebhookRejection, number> = {
  malformed: HttpStatus.BadRequest,
  stale: HttpStatus.Unauthorized,
  signature: HttpStatus.Unauthorized,
};

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function flatHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return headers;
}

/**
 * Reads the body, or `null` when it exceeds `limit`. An oversized body is
 * drained rather than abandoned, so the socket stays usable for the 413.
 */
async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size <= limit) {
      chunks.push(buffer);
    }
  }
  return size > limit ? null : Buffer.concat(chunks).toString('utf8');
}

function parseJson(raw: string): {
  ok: boolean;
  value?: unknown;
} {
  try {
    return {
      ok: true,
      value: JSON.parse(raw),
    };
  } catch {
    return {
      ok: false,
    };
  }
}

function pruneSeen(endpoint: Endpoint, now: number, toleranceMs: number): void {
  // A delivery older than the window is rejected as stale, so ids seen more
  // than twice the window ago can never be replayed successfully.
  for (const [id, at] of endpoint.seen) {
    if (now - at > toleranceMs * 2) {
      endpoint.seen.delete(id);
    }
  }
}

function endpointFor(state: ReceiverState, url: string | undefined): Endpoint | undefined {
  const pathname = new URL(url ?? '/', 'http://receiver').pathname;
  if (!pathname.startsWith(`${state.prefix}/`)) {
    return undefined;
  }
  return state.endpoints.get(decodeURIComponent(pathname.slice(state.prefix.length + 1)));
}

async function dispatch(
  state: ReceiverState,
  endpoint: Endpoint,
  delivery: WebhookDelivery,
): Promise<Reply> {
  if (endpoint.seen.has(delivery.id)) {
    return {
      status: HttpStatus.Duplicate,
    };
  }
  if (endpoint.inFlight.has(delivery.id)) {
    return {
      status: HttpStatus.Conflict,
    };
  }
  endpoint.inFlight.add(delivery.id);
  try {
    await endpoint.onDelivery(delivery);
    endpoint.seen.set(delivery.id, state.now());
    return {
      status: HttpStatus.Accepted,
    };
  } catch {
    return {
      status: HttpStatus.HandlerFailed,
    };
  } finally {
    endpoint.inFlight.delete(delivery.id);
  }
}

/** A raw endpoint answers with its handler's status; a handler that throws answers 500. */
async function answerRaw(handler: RawWebhookHandler, request: RawWebhookRequest): Promise<Reply> {
  try {
    const { status } = await handler(request);
    return {
      status,
    };
  } catch {
    return {
      status: HttpStatus.HandlerFailed,
    };
  }
}

async function handle(state: ReceiverState, req: IncomingMessage): Promise<Reply> {
  const endpoint = endpointFor(state, req.url);
  if (!endpoint) {
    return {
      status: HttpStatus.NotFound,
    };
  }
  if (req.method !== 'POST') {
    return {
      status: HttpStatus.MethodNotAllowed,
    };
  }
  if (Number(headerOf(req, 'content-length') ?? 0) > state.maxBodyBytes) {
    return {
      status: HttpStatus.TooLarge,
    };
  }
  const rawBody = await readBody(req, state.maxBodyBytes);
  if (rawBody === null) {
    return {
      status: HttpStatus.TooLarge,
    };
  }
  if (endpoint.raw) {
    return answerRaw(endpoint.raw, {
      headers: flatHeaders(req),
      body: rawBody,
    });
  }
  const now = state.now();
  const id = headerOf(req, 'webhook-id');
  const timestamp = headerOf(req, 'webhook-timestamp');
  const verification = verifyStandardWebhook({
    secret: endpoint.secret,
    id,
    timestamp,
    signature: headerOf(req, 'webhook-signature'),
    body: rawBody,
    now,
    toleranceMs: state.toleranceMs,
  });
  if (!verification.ok) {
    return {
      status: REJECTION_STATUS[verification.reason],
      body: verification.reason,
    };
  }
  const parsed = parseJson(rawBody);
  if (!parsed.ok || !id || !timestamp) {
    return {
      status: HttpStatus.BadRequest,
      body: 'malformed',
    };
  }
  pruneSeen(endpoint, now, state.toleranceMs);
  return dispatch(state, endpoint, {
    id,
    timestamp: Number(timestamp),
    body: parsed.value,
    rawBody,
    headers: flatHeaders(req),
  });
}

function respond(res: ServerResponse, reply: Reply): void {
  res.statusCode = reply.status;
  res.end(reply.body ?? '');
}

//#endregion

//#region Options

function normalizePrefix(prefix: string | undefined): string {
  const value = (prefix ?? DEFAULT_PATH).replace(/\/+$/, '');
  return value.startsWith('/') ? value : `/${value}`;
}

function normalizePublicUrl(publicUrl: string | undefined): string | undefined {
  if (publicUrl === undefined) {
    return undefined;
  }
  const url = new URL(publicUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`createWebhookReceiver: publicUrl must be http(s), got ${url.protocol}`);
  }
  return url.toString().replace(/\/+$/, '');
}

function localBase(hostname: string, port: number): string {
  const host = hostname.includes(':') ? `[${hostname}]` : hostname;
  return `http://${host}:${port}`;
}

//#endregion

//#region Public API

/** Never called: a raw endpoint's deliveries go to its raw handler. */
async function rawOnly(): Promise<void> {}

/**
 * @public
 * Create the Node webhook receiver passed to `mcp({ webhooks })` (spec 25).
 * Endpoints live at `<publicUrl><path>/<endpoint id>`; the HTTP server starts
 * on the first `register` (or an explicit `listen`).
 */
export function createWebhookReceiver(options: CreateWebhookReceiverOptions = {}): WebhookReceiver {
  const publicUrl = normalizePublicUrl(options.publicUrl);
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const state: ReceiverState = {
    endpoints: new Map(),
    prefix: normalizePrefix(options.path),
    maxBodyBytes: options.maxBodyBytes ?? WEBHOOK_MAX_BODY_BYTES,
    toleranceMs: options.toleranceMs ?? WEBHOOK_TOLERANCE_MS,
    now: options.now ?? Date.now,
  };
  const server: Server = createServer((req, res) => {
    handle(state, req).then(
      (reply) => respond(res, reply),
      () =>
        respond(res, {
          status: HttpStatus.BadRequest,
        }),
    );
  });
  let listening: Promise<{
    port: number;
  }> | null = null;

  const listen = (): Promise<{
    port: number;
  }> => {
    listening ??= new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, hostname, () => {
        server.off('error', reject);
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('createWebhookReceiver: server is not bound to a TCP port'));
          return;
        }
        resolve({
          port: address.port,
        });
      });
    });
    return listening;
  };

  return {
    listen,
    async register(input) {
      const { port } = await listen();
      const raw = typeof input === 'function' ? input : undefined;
      const registration: WebhookRegistration =
        typeof input === 'function'
          ? {
              onDelivery: rawOnly,
            }
          : input;
      const secret = registration.secret ?? generateWebhookSecret();
      // Validates the secret before any delivery depends on it.
      secretKey(secret);
      const id = randomUUID();
      state.endpoints.set(id, {
        id,
        secret,
        onDelivery: registration.onDelivery,
        ...(raw
          ? {
              raw,
            }
          : {}),
        seen: new Map(),
        inFlight: new Set(),
      });
      const unregister = (): void => {
        state.endpoints.delete(id);
      };
      registration.signal?.addEventListener('abort', unregister, {
        once: true,
      });
      if (registration.signal?.aborted) {
        unregister();
      }
      return {
        id,
        url: `${publicUrl ?? localBase(hostname, port)}${state.prefix}/${id}`,
        secret,
        close: async () => unregister(),
      };
    },
    async close() {
      state.endpoints.clear();
      if (!listening) {
        return;
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      listening = null;
    },
  };
}

//#endregion
