/**
 * Webhook delivery for the Events extension: the receiver contract a host
 * passes to `mcp({ webhooks })` (`@noetic-tools/platform-node`'s
 * `createWebhookReceiver()` implements it), and Standard Webhooks
 * (https://www.standardwebhooks.com) signing and verification — an HMAC-SHA256
 * over `<id>.<timestamp>.<body>`, a five-minute timestamp window, and
 * duplicate ids dropped. Uses Web Crypto, so it runs on any runtime.
 */

//#region Types

/** @public One HTTP request a receiver got. Header names are lowercase. */
export interface WebhookDelivery {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** @public What a delivery handler answers: the HTTP status to reply with. */
export interface WebhookReply {
  readonly status: number;
}

/** @public One registered endpoint. */
export interface WebhookRegistration {
  /** The public URL a server POSTs deliveries to. */
  readonly url: string;
  close(): Promise<void>;
}

/**
 * @public
 * Receives webhook deliveries over HTTP. Each `register` call opens a distinct
 * URL whose deliveries go to `handler`.
 */
export interface WebhookReceiver {
  register(
    handler: (delivery: WebhookDelivery) => Promise<WebhookReply>,
  ): Promise<WebhookRegistration>;
}

/** @public `mcp({ webhooks })`. */
export interface McpWebhooks {
  readonly receiver: WebhookReceiver;
  /** Timestamp tolerance; default 300 s. */
  readonly toleranceSec?: number;
}

/** @public The delivery ids already accepted (a `Set<string>` works). */
export interface SeenIds {
  has(id: string): boolean;
  add(id: string): void;
}

/** @public Why a delivery was refused. */
export type WebhookRejection =
  | 'missing_headers'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'bad_signature'
  | 'duplicate';

/** @public A verification outcome. */
export type WebhookVerification =
  | {
      readonly ok: true;
      readonly id: string;
    }
  | {
      readonly ok: false;
      readonly reason: WebhookRejection;
    };

//#endregion

//#region Constants

/** @public Default timestamp tolerance (five minutes). */
export const WEBHOOK_TOLERANCE_SEC = 300;

const SECRET_PREFIX = 'whsec_';

//#endregion

//#region Helpers

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function secretKeyBytes(secret: string): Uint8Array<ArrayBuffer> {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return fromBase64(raw);
}

async function hmac(secret: string, content: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    secretKeyBytes(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    [
      'sign',
    ],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(content));
  return toBase64(new Uint8Array(signature));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

//#endregion

//#region Public API

/** @public A fresh `whsec_` signing secret (24 random bytes). */
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `${SECRET_PREFIX}${toBase64(bytes)}`;
}

/**
 * @public
 * Signs a delivery the Standard Webhooks way, returning the three headers a
 * sender sets.
 */
export async function signWebhook(params: {
  secret: string;
  id: string;
  timestampSec: number;
  body: string;
}): Promise<Record<string, string>> {
  const signature = await hmac(params.secret, `${params.id}.${params.timestampSec}.${params.body}`);
  return {
    'webhook-id': params.id,
    'webhook-timestamp': String(params.timestampSec),
    'webhook-signature': `v1,${signature}`,
  };
}

/**
 * @public
 * Verifies a Standard Webhooks delivery: the signature (any `v1,` entry of the
 * space-separated list), the timestamp within `toleranceSec` of `nowSec`, and
 * — when `seen` is given — that the id was not delivered before. A verified id
 * is added to `seen`.
 */
export async function verifyWebhook(params: {
  secret: string;
  delivery: WebhookDelivery;
  nowSec: number;
  toleranceSec?: number;
  seen?: SeenIds;
}): Promise<WebhookVerification> {
  const id = params.delivery.headers['webhook-id'];
  const timestamp = params.delivery.headers['webhook-timestamp'];
  const signatures = params.delivery.headers['webhook-signature'];
  if (id === undefined || timestamp === undefined || signatures === undefined) {
    return {
      ok: false,
      reason: 'missing_headers',
    };
  }
  const timestampSec = Number(timestamp);
  if (!Number.isInteger(timestampSec)) {
    return {
      ok: false,
      reason: 'bad_timestamp',
    };
  }
  const tolerance = params.toleranceSec ?? WEBHOOK_TOLERANCE_SEC;
  if (Math.abs(params.nowSec - timestampSec) > tolerance) {
    return {
      ok: false,
      reason: 'stale_timestamp',
    };
  }
  const expected = await hmac(params.secret, `${id}.${timestampSec}.${params.delivery.body}`);
  const matched = signatures
    .split(' ')
    .some((entry) => entry.startsWith('v1,') && constantTimeEqual(entry.slice(3), expected));
  if (!matched) {
    return {
      ok: false,
      reason: 'bad_signature',
    };
  }
  if (params.seen?.has(id)) {
    return {
      ok: false,
      reason: 'duplicate',
    };
  }
  params.seen?.add(id);
  return {
    ok: true,
    id,
  };
}

//#endregion
