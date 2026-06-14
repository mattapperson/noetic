/**
 * Builders that turn agent output into Noetic conversation `Item`s. The shapes
 * mirror the OpenRouter output-item schema the runtime stores; construction
 * goes through `frameworkCast` because those provider types are not publicly
 * constructible.
 */

import type { FunctionCallItem, Item, MessageItem } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';

/** @public Build an assistant message Item from plain text. */
export function assistantMessageItem(text: string, id?: string): MessageItem {
  return frameworkCast<MessageItem>({
    id: id ?? `sub-harness-msg-${crypto.randomUUID()}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text,
        annotations: [],
      },
    ],
  });
}

/** @public Build a function-call Item recording a tool the agent invoked. */
export function functionCallItem(opts: {
  name: string;
  input: unknown;
  callId?: string;
  id?: string;
}): FunctionCallItem {
  const callId = opts.callId ?? `call-${crypto.randomUUID()}`;
  const args = typeof opts.input === 'string' ? opts.input : JSON.stringify(opts.input ?? {});
  return frameworkCast<FunctionCallItem>({
    id: opts.id ?? callId,
    type: 'function_call',
    status: 'completed',
    name: opts.name,
    callId,
    arguments: args,
  });
}

/** @public Coerce an arbitrary item collection to the `Item[]` type. */
export function asItems(items: ReadonlyArray<unknown>): Item[] {
  return frameworkCast<Item[]>([
    ...items,
  ]);
}
