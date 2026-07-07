/**
 * Client-side descriptors for wiring OpenUI's React stack (`fetchLLM`) to a
 * Noetic `serveOpenUi` endpoint. These are framework-agnostic: they describe
 * the protocol so an OpenUI `streamAdapter` / `messageFormat` pair can consume
 * the SSE frames `serveOpenUi` emits without the client importing anything
 * from core.
 */

import type { OpenUiServerMessage } from './protocol';
import { OPENUI_PROTOCOL, OpenUiServerMessageSchema } from './protocol';

/** @public Parse one SSE `data:` line into a server message, or null if not a valid data frame. */
export function parseSseFrame(line: string): OpenUiServerMessage | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('data:')) {
    return null;
  }
  const payload = trimmed.slice('data:'.length).trim();
  if (payload.length === 0) {
    return null;
  }
  const parsed = OpenUiServerMessageSchema.safeParse(JSON.parse(payload));
  return parsed.success ? parsed.data : null;
}

/**
 * A minimal stream adapter descriptor an OpenUI client can use with `fetchLLM`.
 * The client POSTs `{ prompt }` and reads SSE frames; each frame is a
 * {@link OpenUiServerMessage}.
 * @public
 */
export interface NoeticStreamAdapter {
  protocol: string;
  /** How the client should frame a prompt request body. */
  requestBody(prompt: string): {
    prompt: string;
  };
  /** How the client should frame a UI-event request body. */
  eventBody(event: unknown): {
    event: unknown;
  };
  /** Parse a single SSE line into a message. */
  parseFrame(line: string): OpenUiServerMessage | null;
}

/** @public Build the stream adapter descriptor. */
export function noeticStreamAdapter(): NoeticStreamAdapter {
  return {
    protocol: OPENUI_PROTOCOL,
    requestBody: (prompt: string) => ({
      prompt,
    }),
    eventBody: (event: unknown) => ({
      event,
    }),
    parseFrame: parseSseFrame,
  };
}
