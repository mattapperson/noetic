import type { AgentScope, Context } from '@noetic-tools/types';
import type { EventBroadcaster } from './event-broadcaster';

//#region Types

/** @internal Option controlling framework event emission on a step or callModel request. */
export type EmitOption =
  | boolean
  | ((eventType: string, data: Record<string, unknown>, ctx?: Context) => boolean);

//#endregion

//#region Public API

/**
 * Check whether a framework event should be emitted given an emit option.
 *
 * When `emit` is `undefined` (the default for non-LLM steps where the
 * field does not exist on the Step type), events are always emitted.
 * Only StepCallModel exposes `emit` for opt-out or filtering.
 *
 * @internal
 */
export function shouldEmit(
  emit: EmitOption | undefined,
  eventType: string,
  data: Record<string, unknown>,
): boolean {
  if (emit === undefined || emit === true) {
    return true;
  }
  if (emit === false) {
    return false;
  }
  return emit(eventType, data);
}

/** `emit` with its filter, when it is one, given `ctx` as the context of the step it filters for. */
export function emitOn(
  emit: EmitOption | undefined,
  ctx: Context | undefined,
): EmitOption | undefined {
  return typeof emit === 'function' ? (eventType, data) => emit(eventType, data, ctx) : emit;
}

/** Typeguard: context carries an internal _broadcaster property. */
function hasBroadcaster(ctx: Context): ctx is Context & {
  _broadcaster: EventBroadcaster;
} {
  if (!('_broadcaster' in ctx)) {
    return false;
  }
  return typeof ctx._broadcaster === 'object' && ctx._broadcaster !== null;
}

/**
 * Get the EventBroadcaster from a context if available. Walks up the parent
 * chain so spawned child contexts inherit the session-level broadcaster — the
 * interpreter never re-installs `_broadcaster` on spawn children, so without
 * this traversal every LLM call inside a `spawn()` step would be invisible to
 * the UI stream.
 * Uses property check rather than instanceof to support mock contexts in tests.
 * @internal
 */
export function getBroadcaster(ctx?: Context): EventBroadcaster | undefined {
  let current: Context | null | undefined = ctx;
  while (current) {
    if (hasBroadcaster(current)) {
      return current._broadcaster;
    }
    current = current.parent ?? null;
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
  /** The nested agent the event belongs to (spec 08 § Nested agents). */
  scope?: AgentScope;
}): void {
  opts.broadcaster?.emit({
    source: 'framework',
    type: `${opts.agentName}:${opts.eventType}`,
    data: opts.data,
    ...(opts.scope
      ? {
          scope: opts.scope,
        }
      : {}),
  });
}

//#endregion
