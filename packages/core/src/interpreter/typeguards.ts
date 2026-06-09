import type { ContextMemory } from '@noetic-tools/memory';
import type { Context, FunctionCallItem, Item } from '@noetic-tools/types';
import type { ChannelStore } from '../runtime/channel-store';
import { ContextImpl } from '../runtime/context-impl';
import type { MutableContext } from '../types/mutable-context';

// Re-exports for backward compatibility; the pure variants live in util/.
export { isAssistantMessage, isOutputText, isUserMessage } from '@noetic-tools/types';

export function isMutableContext(ctx: Context<ContextMemory>): ctx is MutableContext {
  // Check if the context has writable mutable fields (ContextImpl or compatible mock)
  if (ctx instanceof ContextImpl) {
    return true;
  }
  // Duck-type check: verify the fields we need to mutate are present and writable
  const desc = Object.getOwnPropertyDescriptor(ctx, 'stepCount');
  return desc !== undefined && desc.writable !== false;
}

export function isContextImpl(ctx: Context<ContextMemory>): ctx is ContextImpl {
  return ctx instanceof ContextImpl;
}

/**
 * Co-located with `isContextImpl` so the import of `ContextImpl` flows through
 * the same module other interpreters pull it from, sidestepping a circular
 * TDZ when this helper is used by `executeEvery` in `execute-control.ts`.
 */
export function getContextChannelStore<TMemory>(ctx: Context<TMemory>): ChannelStore | undefined {
  if (ctx instanceof ContextImpl) {
    return ctx.channelStore;
  }
  return undefined;
}

export function isFunctionCall(item: Item): item is FunctionCallItem {
  return item.type === 'function_call' && 'callId' in item && 'name' in item;
}

function assertNever(_value: never): never {
  throw new Error('Exhaustive check failed');
}

export { assertNever };
