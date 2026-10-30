import { NoeticEvent } from '../observability/genai-attributes';
import { SpanImpl } from '../observability/span-impl';
import { NoopExporter } from '../observability/trace-exporter';
import type { ChannelWarning } from './deps/runtime';
import { warnToConsole } from './deps/runtime';
import type { Context, Span, TraceExporter } from './deps/types';

/** The exporter a harness flushes spans to: the one configured, else a no-op exporter. */
export function resolveTraceExporter(exporter: TraceExporter | undefined): TraceExporter {
  return exporter ?? new NoopExporter();
}

/** A harness span: one the harness's trace exporter receives. */
export function createHarnessSpan(name: string, parent: Span | null): Span {
  return new SpanImpl(name, parent);
}

/**
 * Channel state is shared by every root on a harness, so a channel warning is
 * recorded as a `channel.warning` event on each live root's span (spec 10). A
 * root span counts only if it will reach the trace exporter — a harness span
 * (`SpanImpl`) with a real exporter configured. With no such span the warning
 * goes to the console, so it is never lost.
 */
export function recordChannelWarning(
  warning: ChannelWarning,
  traceExporter: TraceExporter,
  liveRoots: Iterable<{
    ctx: Context;
  }>,
): void {
  const traced =
    traceExporter instanceof NoopExporter
      ? []
      : [
          ...liveRoots,
        ].filter(({ ctx }) => ctx.span instanceof SpanImpl);
  if (traced.length === 0) {
    warnToConsole(warning);
    return;
  }
  for (const { ctx } of traced) {
    ctx.span.addEvent(NoeticEvent.CHANNEL_WARNING, {
      ...warning,
    });
  }
}
