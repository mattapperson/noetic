import type { Context } from '../types/context';
import type { EventBroadcaster } from './event-broadcaster';

//#region Type Guards

function hasOwnBroadcaster(ctx: Context): ctx is Context & {
  _broadcaster: EventBroadcaster;
} {
  return '_broadcaster' in ctx && ctx._broadcaster !== undefined && ctx._broadcaster !== null;
}

//#endregion

//#region Public API

/**
 * Get the EventBroadcaster from a context if available.
 * @internal
 */
export function getBroadcaster(ctx?: Context): EventBroadcaster | undefined {
  if (!ctx) {
    return undefined;
  }
  if (hasOwnBroadcaster(ctx)) {
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
