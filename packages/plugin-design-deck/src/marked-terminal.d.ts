/**
 * Minimal ambient declaration for marked-terminal v7.
 * The @types/marked-terminal package is stale (v6) and miscompiles against
 * marked v15. At runtime `markedTerminal()` returns a MarkedExtension that
 * `marked.use()` accepts — we only need that contract.
 */
declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  export interface MarkedTerminalOptions {
    reflowText?: boolean;
    width?: number;
    [key: string]: unknown;
  }

  export function markedTerminal(
    options?: MarkedTerminalOptions,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension;
}
