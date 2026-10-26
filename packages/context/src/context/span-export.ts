import type { Span, TraceExporter } from '@noetic-tools/types';

/**
 * Hands ended spans to `exporter` without letting it fail the traced work: a
 * rejecting (or throwing) exporter is reported once as a warning and
 * swallowed, so tracing never changes what a hook, step, or call returns.
 */
export async function exportSpans(exporter: TraceExporter, spans: Span[]): Promise<void> {
  try {
    await exporter.export(spans);
  } catch (error) {
    console.warn('[noetic] trace export failed; the traced work is unaffected:', error);
  }
}
