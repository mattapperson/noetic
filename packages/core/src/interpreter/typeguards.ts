import { ContextImpl } from '../runtime/context-impl';
import type { Context } from '../types/context';
import type { FunctionCallItem, Item, MessageItem } from '../types/items';
import type { ContextMemory } from '../types/memory';
import type { MutableContext } from '../types/mutable-context';

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

export function isAssistantMessage(item: unknown): item is MessageItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'message' &&
    'role' in item &&
    item.role === 'assistant'
  );
}

export function isUserMessage(item: unknown): item is MessageItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'message' &&
    'role' in item &&
    item.role === 'user'
  );
}

export function isFunctionCall(item: Item): item is FunctionCallItem {
  return item.type === 'function_call' && 'callId' in item && 'name' in item;
}

export function isOutputText(part: { type: string }): part is {
  type: 'output_text';
  text: string;
} {
  return part.type === 'output_text';
}

function assertNever(_value: never): never {
  throw new Error('Exhaustive check failed');
}

export { assertNever };
