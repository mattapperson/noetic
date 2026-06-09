/**
 * Portable replacements for `randomBytes(n).toString(...)`. Uses Web
 * Crypto (`globalThis.crypto.getRandomValues`), available in Node ≥18,
 * Bun, and most runtimes.
 */

const HEX = '0123456789abcdef';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Hex-encoded random bytes. `randomHex(4)` returns 8 hex chars. */
export function randomHex(n: number): string {
  const bytes = randomBytes(n);
  let out = '';
  for (const byte of bytes) {
    out += HEX[byte >> 4];
    out += HEX[byte & 0xf];
  }
  return out;
}

/**
 * Base64url-encoded random bytes. Uses the Web standard alphabet
 * (`-` and `_`) and no padding — matches Node's `randomBytes(n).toString('base64url')`.
 */
export function randomBase64Url(n: number): string {
  const bytes = randomBytes(n);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
