import type { Context } from '../types/context';
import { ContextImpl } from './context-impl';
import type { EventBroadcaster } from './event-broadcaster';

//#region Public API

/**
 * Get the EventBroadcaster from a context if available.
 * Uses instanceof ContextImpl rather than `in` operator to avoid
 * leaking the internal `_broadcaster` property through type guards.
 * @internal
 */
export function getBroadcaster(ctx?: Context): EventBroadcaster | undefined {
  if (!ctx) {
    return undefined;
  }
  if (ctx instanceof ContextImpl) {
    return ctx._broadcaster;
  }
  return undefined;
}

/**
 * Emit a framework event to the broadcaster if available.
 * @internal
 */
export function emitFrameworkEvent(opts: {
  broadcaster: EventBroadcaster | undefined;
  agentName: string;
  eventType: string;
  data: Record<string, unknown>;
}): void {
  opts.broadcaster?.emit({
    source: 'framework',
    type: `${opts.agentName}:${opts.eventType}`,
    data: opts.data,
  });
}

//#endregion
