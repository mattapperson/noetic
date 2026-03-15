import { ContextImpl } from '../runtime/context-impl';
import type { Context } from '../types/context';
import type { ContentPart, MessageItem } from '../types/items';
import type { MutableContext } from '../types/mutable-context';

export function isMutableContext(ctx: Context): ctx is MutableContext {
  // Check if the context has writable mutable fields (ContextImpl or compatible mock)
  if (ctx instanceof ContextImpl) {
    return true;
  }
  // Duck-type check: verify the fields we need to mutate are present and writable
  const desc = Object.getOwnPropertyDescriptor(ctx, 'stepCount');
  return desc !== undefined && desc.writable !== false;
}

export function isContextImpl(ctx: Context): ctx is ContextImpl {
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

export function isOutputText(part: ContentPart): part is Extract<
  ContentPart,
  {
    type: 'output_text';
  }
> {
  return part.type === 'output_text';
}

function assertNever(_value: never): never {
  throw new Error('Exhaustive check failed');
}

export { assertNever };
