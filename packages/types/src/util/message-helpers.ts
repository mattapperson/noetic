import type { LLMResponse, TokenUsage } from '../types/common';
import type { Context } from '../types/context';
import type { InputMessageItem, Item, MessageItem } from '../types/items';

interface UsageMutableContext extends Context {
  tokens: TokenUsage;
  cost: number;
}

function canTrackUsage(ctx: Context): ctx is UsageMutableContext {
  const desc = Object.getOwnPropertyDescriptor(ctx, 'stepCount');
  return desc !== undefined && desc.writable !== false;
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

export function isOutputText(part: { type: string }): part is {
  type: 'output_text';
  text: string;
} {
  return part.type === 'output_text';
}

/** True for any content part carrying a string `text` field (input_text, output_text, …). */
export function isTextPart(part: { type: string }): part is {
  type: string;
  text: string;
} {
  return 'text' in part && typeof part.text === 'string';
}

/** Extracts assistant/output text from items for memory buffering (one string per message). */
export function collectOutputText(items: ReadonlyArray<Item>): string[] {
  return items
    .filter((i): i is MessageItem => i.type === 'message')
    .map((i) =>
      i.content
        .filter(isOutputText)
        .map((c: { text: string }) => c.text)
        .join(''),
    )
    .filter((t) => t.length > 0);
}

/**
 * Extracts text from INPUT items for memory buffering: concatenates the text
 * content parts of message items (user `input_text` and any text parts) and
 * appends the `output` of `function_call_output` (tool result) items. Empty
 * strings are dropped.
 */
export function collectInputText(items: ReadonlyArray<Item>): string[] {
  const texts: string[] = [];
  for (const item of items) {
    if (item.type === 'message') {
      let text = '';
      for (const part of item.content) {
        if (isTextPart(part)) {
          text += part.text;
        }
      }
      if (text.length > 0) {
        texts.push(text);
      }
      continue;
    }
    if (item.type === 'function_call_output' && item.output.length > 0) {
      texts.push(item.output);
    }
  }
  return texts;
}

export function createMessage(text: string, role: 'user' | 'developer'): InputMessageItem {
  return {
    id: crypto.randomUUID(),
    status: 'completed',
    type: 'message',
    role,
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

export function extractAssistantText(items: ReadonlyArray<Item>): string {
  const lastMsg = items.findLast(isAssistantMessage);

  if (!lastMsg) {
    return '';
  }

  return (
    lastMsg.content
      ?.filter(isOutputText)
      ?.map((c: { text: string }) => c.text)
      ?.join('') ?? ''
  );
}

/** Naive token estimate: ~4 chars per token */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Accumulate token usage and cost from an LLM response onto a mutable context. */
export function trackUsage(ctx: Context, response: LLMResponse): void {
  if (!canTrackUsage(ctx)) {
    return;
  }
  ctx.tokens.input += response.usage.inputTokens;
  ctx.tokens.output += response.usage.outputTokens;
  ctx.tokens.total += response.usage.inputTokens + response.usage.outputTokens;
  ctx.tokens.cached = (ctx.tokens.cached ?? 0) + (response.usage.cachedTokens ?? 0);
  if (response.cost) {
    ctx.cost = ctx.cost + response.cost;
  }
}
