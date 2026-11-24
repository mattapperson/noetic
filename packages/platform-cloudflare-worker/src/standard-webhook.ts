/**
 * Standard Webhooks verification on Web Crypto, for runtimes with no `node:crypto`
 * (https://www.standardwebhooks.com). `@noetic-tools/platform-node` has the same
 * check on Node's crypto for its own receiver.
 */

//#region Constants

/** @public The Standard Webhooks timestamp tolerance: five minutes. */
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1e3;

const SECRET_PREFIX = 'whsec_';
const SIGNATURE_VERSION = 'v1';

//#endregion

//#region Types

/** @public Options for `standardWebhookVerifier`. */
export interface StandardWebhookVerifierOptions {
  /** The signing secret, with or without its `whsec_` prefix. */
  secret: string;
  /** How far a delivery's timestamp may be from now. Default five minutes. */
  toleranceMs?: number;
  now?: () => number;
}

//#endregion

//#region Helpers

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** The `v1` signatures a `webhook-signature` header carries, decoded. */
function signaturesOf(header: string): Uint8Array<ArrayBuffer>[] {
  const found: Uint8Array<ArrayBuffer>[] = [];
  for (const part of header.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== SIGNATURE_VERSION || value === undefined) {
      continue;
    }
    try {
      found.push(bytesOf(value));
    } catch {
      // Not base64: no signature to check.
    }
  }
  return found;
}

function isFresh(timestamp: string, options: StandardWebhookVerifierOptions): boolean {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) {
    return false;
  }
  const now = (options.now ?? Date.now)();
  return Math.abs(now - seconds * 1e3) <= (options.toleranceMs ?? WEBHOOK_TOLERANCE_MS);
}

//#endregion

//#region Public API

/**
 * @public
 * @throws Error when `secret` is not base64.
 *
 * A `verify` for `eventEndpoint` that checks a Standard Webhooks signature:
 * `webhook-id`, `webhook-timestamp` and `webhook-signature`, within the timestamp
 * tolerance. The comparison is `crypto.subtle.verify`, which runs in constant time.
 *
 * It does not drop a repeated `webhook-id`: a trigger's inbox dedupes by event id,
 * so use the `webhook-id` as the event's id.
 */
export function standardWebhookVerifier(
  options: StandardWebhookVerifierOptions,
): (request: Request, body: string) => Promise<boolean> {
  const secret = options.secret.startsWith(SECRET_PREFIX)
    ? options.secret.slice(SECRET_PREFIX.length)
    : options.secret;
  // Decoded now: a secret that is not base64 is a setup mistake, and is better
  // heard about here than as a refusal of every delivery.
  let secretBytes: Uint8Array<ArrayBuffer>;
  try {
    secretBytes = bytesOf(secret);
  } catch {
    throw new Error(
      'standardWebhookVerifier: the secret is not base64. Pass the signing secret as the provider shows it, with or without its "whsec_" prefix.',
    );
  }
  let key: Promise<CryptoKey> | undefined;

  function importKey(): Promise<CryptoKey> {
    key ??= crypto.subtle.importKey(
      'raw',
      secretBytes,
      {
        name: 'HMAC',
        hash: 'SHA-256',
      },
      false,
      [
        'verify',
      ],
    );
    return key;
  }

  return async (request, body) => {
    const id = request.headers.get('webhook-id');
    const timestamp = request.headers.get('webhook-timestamp');
    const signature = request.headers.get('webhook-signature');
    if (!id || !timestamp || !signature || !isFresh(timestamp, options)) {
      return false;
    }
    const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
    const hmac = await importKey();
    for (const candidate of signaturesOf(signature)) {
      if (await crypto.subtle.verify('HMAC', hmac, candidate, signed)) {
        return true;
      }
    }
    return false;
  };
}

//#endregion
