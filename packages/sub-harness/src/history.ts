/**
 * Helpers for giving a sub-harness the prior conversation. A fresh session is
 * seeded with the conversation history (see {@link SubHarnessTurnInput.history});
 * these helpers turn that history into a transcript a vendor agent can read, so
 * the agent has full context of the conversation rather than only the latest
 * prompt.
 */

import type { Item } from '@noetic-tools/types';

function roleLabel(role: string): string {
  if (role === 'assistant') {
    return 'Assistant';
  }
  if (role === 'user') {
    return 'User';
  }
  return 'System';
}

function messageText(item: Item): string | null {
  if (item.type !== 'message') {
    return null;
  }
  const text = item.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('');
  return text.length > 0 ? `${roleLabel(item.role)}: ${text}` : null;
}

/** @public Render conversation history as a plain-text transcript. */
export function formatConversation(items: ReadonlyArray<Item>): string {
  const lines: string[] = [];
  for (const item of items) {
    const line = messageText(item);
    if (line) {
      lines.push(line);
      continue;
    }
    if (item.type === 'function_call') {
      lines.push(`Assistant called ${item.name}(${item.arguments})`);
    }
  }
  return lines.join('\n');
}

/**
 * Fold a turn's history into its prompt. Returns the prompt unchanged when there
 * is no history. Default runners use this so the agent sees the conversation.
 * @public
 */
export function withHistoryPrompt(input: { prompt: string; history: ReadonlyArray<Item> }): string {
  if (input.history.length === 0) {
    return input.prompt;
  }
  return `Conversation so far:\n${formatConversation(input.history)}\n\nCurrent request:\n${input.prompt}`;
}
