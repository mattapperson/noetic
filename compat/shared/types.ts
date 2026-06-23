/**
 * Shared result shapes for the cross-platform deployment smoke test.
 *
 * These types are intentionally free of any runtime-specific (`node:`, DOM,
 * Worker) references so the module imports cleanly on every target.
 */

/** Identifiers for the five deployment targets the suite exercises. */
export const Runtime = {
  Node: 'node',
  Bun: 'bun',
  Deno: 'deno',
  Browser: 'browser',
  Cloudflare: 'cloudflare',
} as const;

export type Runtime = (typeof Runtime)[keyof typeof Runtime];

/** Outcome of the `@noetic-tools/core` live OpenRouter step. */
export interface CoreSmokeResult {
  /** The trimmed assistant reply from the live model call. */
  reply: string;
  /** Total input tokens reported by the harness Context. */
  inputTokens: number;
  /** Total output tokens reported by the harness Context. */
  outputTokens: number;
}

/** Full smoke result returned by {@link runSmoke}. */
export interface SmokeResult {
  ok: true;
  runtime: Runtime;
  model: string;
  core: CoreSmokeResult;
  /** Wall-clock duration of the whole smoke in milliseconds. */
  durationMs: number;
}

/** Options accepted by {@link runSmoke}. */
export interface SmokeOptions {
  runtime: Runtime;
  apiKey: string;
  /** OpenRouter model id. Defaults to `openai/gpt-4o-mini`. */
  model?: string;
  /** Millisecond clock; injected so the module stays runtime-agnostic. */
  now?: () => number;
}
