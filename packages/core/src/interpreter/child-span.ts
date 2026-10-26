/**
 * Spans that steps open under `ctx.span`: child contexts (`spawn` children and
 * `inParallel` paths) and direct `invokeTool` calls. A child context carries
 * its own span, so events its steps add to `ctx.span` (e.g. `loop.verdict`)
 * and the model/tool spans they open nest under the child rather than being
 * lost to a no-op span.
 */

import { exportSpans } from '@noetic-tools/context';
import type { Context, Span } from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import { NoeticAttr } from '../observability/genai-attributes';

/** Opens a span named `name` under `parent.span`, stamped with the owning step id. */
export function openChildSpan(parent: Context, name: string, stepId: string): Span {
  const span = parent.harness.createSpan(name, parent.span);
  span.setAttribute(NoeticAttr.NODE_ID, stepId);
  return span;
}

/**
 * Runs `run` inside `span`, then ends the span and exports it, whether `run`
 * returns or throws. A failure stamps `noetic.error.kind`; any failure but
 * cancellation also stamps `error: true`.
 */
export async function traceChild<T>(
  parent: Context,
  span: Span,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    markFailed(span, e);
    throw e;
  } finally {
    await closeChildSpan(parent, span);
  }
}

/** Ends a span whose child never ran: it was cancelled before it started. */
export async function closeUnstartedSpan(parent: Context, span: Span): Promise<void> {
  span.setAttribute(NoeticAttr.ERROR_KIND, 'cancelled');
  await closeChildSpan(parent, span);
}

function markFailed(span: Span, error: unknown): void {
  const kind = isNoeticError(error) ? error.noeticError.kind : undefined;
  if (kind !== undefined) {
    span.setAttribute(NoeticAttr.ERROR_KIND, kind);
  }
  if (kind !== 'cancelled') {
    span.setAttribute('error', true);
  }
}

async function closeChildSpan(parent: Context, span: Span): Promise<void> {
  span.end();
  await exportSpans(parent.harness.traceExporter, [
    span,
  ]);
}
