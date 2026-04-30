/**
 * Diagnostic store and merge. LSP servers can deliver diagnostics via two
 * channels:
 *
 *   - Push: `textDocument/publishDiagnostics` notification — server-initiated.
 *   - Pull: `textDocument/diagnostic` request — client-initiated.
 *
 * We keep a per-URI map of the latest push payload, and merge it with a
 * freshly-pulled payload on demand, deduping by `(range, message, source)`.
 */

import type { Diagnostic } from 'vscode-languageserver-protocol';

//#region Store

/**
 * In-memory store of the latest pushed diagnostics per URI. A new push for a
 * given URI replaces the previous list (matches LSP semantics — the server is
 * sending the authoritative current state).
 */
export class DiagnosticStore {
  private readonly byUri = new Map<string, ReadonlyArray<Diagnostic>>();

  recordPush(uri: string, diagnostics: ReadonlyArray<Diagnostic>): void {
    this.byUri.set(uri, diagnostics);
  }

  getPushed(uri: string): ReadonlyArray<Diagnostic> {
    return this.byUri.get(uri) ?? [];
  }

  clear(uri: string): void {
    this.byUri.delete(uri);
  }

  clearAll(): void {
    this.byUri.clear();
  }
}

//#endregion

//#region Merge

function diagnosticKey(d: Diagnostic): string {
  const { range, message, source } = d;
  const s = source ?? '';
  return `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}:${s}:${message}`;
}

/**
 * Merge push + pull diagnostics, deduplicating by (range, message, source).
 * Preserves the order: pushed diagnostics first, then any pulled entries that
 * weren't already covered.
 */
export function mergeDiagnostics(
  pushed: ReadonlyArray<Diagnostic>,
  pulled: ReadonlyArray<Diagnostic>,
): ReadonlyArray<Diagnostic> {
  const seen = new Set<string>();
  const merged: Diagnostic[] = [];
  for (const d of pushed) {
    const key = diagnosticKey(d);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(d);
  }
  for (const d of pulled) {
    const key = diagnosticKey(d);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(d);
  }
  return merged;
}

//#endregion
