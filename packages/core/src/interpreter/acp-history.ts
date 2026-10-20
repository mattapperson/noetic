/**
 * Gives an ACP agent the prior conversation.
 *
 * ACP sessions own their own history on the agent side, but a freshly opened
 * session knows nothing about the Noetic steps that ran before it. Seeding the
 * first prompt with a transcript of the conversation so far means a coding agent
 * running after a chain of `callModel` steps understands what was already
 * established instead of answering out of context.
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
 * Fold the conversation so far into a turn's prompt. Returns the prompt
 * unchanged when there is no history, so the very first step of a run is not
 * padded with an empty preamble.
 * @public
 */
export function withHistoryPrompt(input: { prompt: string; history: ReadonlyArray<Item> }): string {
  if (input.history.length === 0) {
    return input.prompt;
  }
  const transcript = formatConversation(input.history);
  if (transcript.length === 0) {
    return input.prompt;
  }
  return `Conversation so far:\n${transcript}\n\nCurrent request:\n${input.prompt}`;
}
