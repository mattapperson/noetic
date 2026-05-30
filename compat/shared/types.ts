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

/** Outcome of the `@noetic-tools/code-agent` portable-surface exercise. */
export interface CodeAgentSmokeResult {
  /** Content read back through the in-memory fs tool round-trip. */
  fileRoundTrip: string;
  /** The trimmed assistant reply from a live call through the agent harness. */
  reply: string;
  /** Number of portable tools the agent registered. */
  toolCount: number;
}

/** Full smoke result returned by {@link runSmoke}. */
export interface SmokeResult {
  ok: true;
  runtime: Runtime;
  model: string;
  core: CoreSmokeResult;
  /**
   * `null` when code-agent was intentionally skipped on this runtime (browser),
   * with the reason in {@link codeAgentSkipReason}. The published code-agent
   * `dist` statically imports `node:url`/LSP modules, so it only loads on
   * runtimes with Node compatibility (Node, Bun, Deno, Workers).
   */
  codeAgent: CodeAgentSmokeResult | null;
  codeAgentSkipReason?: string;
  /** Wall-clock duration of the whole smoke in milliseconds. */
  durationMs: number;
}

/** Options accepted by {@link runSmoke}. */
export interface SmokeOptions {
  runtime: Runtime;
  apiKey: string;
  /** OpenRouter model id. Defaults to `openai/gpt-4o-mini`. */
  model?: string;
  /**
   * Whether to exercise `@noetic-tools/code-agent`. Defaults to `true`. The
   * browser target sets this to `false` because code-agent's built `dist` is
   * not browser-bundleable (static `node:url`/LSP imports).
   */
  includeCodeAgent?: boolean;
  /** Millisecond clock; injected so the module stays runtime-agnostic. */
  now?: () => number;
}
