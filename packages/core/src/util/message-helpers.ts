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
