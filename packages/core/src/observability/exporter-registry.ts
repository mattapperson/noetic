/**
 * Exporter factory registry
 *
 * Allows external packages (like @noetic/ui) to register a TraceExporter
 * factory that AgentHarness can resolve lazily at run time.
 */

import type { TraceExporter } from '../types/observability';

let factory: (() => TraceExporter) | null = null;
let cached: TraceExporter | null = null;

/** Register a factory that creates a TraceExporter. Warns if overwriting. */
export function registerExporterFactory(f: () => TraceExporter): void {
  if (factory !== null) {
    console.warn('[noetic] Overwriting previously registered exporter factory');
  }
  factory = f;
  cached = null; // invalidate cache
}

/** Get the registered exporter (singleton — factory called once, result cached). Returns null if no factory registered. */
export function getRegisteredExporter(): TraceExporter | null {
  if (!factory) {
    return null;
  }
  cached ??= factory();
  return cached;
}

/** Clear the registry. For testing only. */
export function clearExporterFactory(): void {
  factory = null;
  cached = null;
}
