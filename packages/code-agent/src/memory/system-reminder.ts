/**
 * Helpers for wrapping and injecting `<system-reminder>` blocks mid-conversation.
 *
 * Reminders are injected as developer-role messages so they are clearly
 * distinguishable from genuine user input and from assistant output. The
 * `<system-reminder>` XML wrap is a signal to the model that the content is
 * scaffolding rather than new user instruction.
 */

import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  InputMessageItem,
  Item,
  MessageItem,
} from '@noetic/core';

//#region Typeguards

/** Checks whether an item is an assistant-authored message. */
export function isAssistantMessage(item: Item): item is MessageItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'message' &&
    'role' in item &&
    item.role === 'assistant'
  );
}

/** Checks whether an item is a function-call request issued by the model. */
export function isFunctionCallItem(item: Item): item is FunctionCallItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'function_call' &&
    'name' in item
  );
}

/** Checks whether an item is a function-call output (tool result). */
export function isFunctionCallOutputItem(item: Item): item is FunctionCallOutputItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'function_call_output'
  );
}

//#endregion

//#region Wrapping

/** Wrap `body` in a `<system-reminder>` XML block. */
export function wrapInSystemReminder(body: string): string {
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

/** Create a developer-role `InputMessageItem` carrying the given text. */
export function createDeveloperMessage(text: string): InputMessageItem {
  return {
    id: crypto.randomUUID(),
    status: 'completed',
    type: 'message',
    role: 'developer',
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

//#endregion
