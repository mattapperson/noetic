import type { LLMResponse } from '../types/common';
import type { Context } from '../types/context';
import type { Item, MessageItem } from '../types/items';
import { isAssistantMessage, isMutableContext, isOutputText } from './typeguards';

export function createMessage(text: string, role: 'user' | 'developer'): MessageItem {
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
      ?.map((c) => c.text)
      ?.join('') ?? ''
  );
}

/** Naive token estimate: ~4 chars per token */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Accumulate token usage and cost from an LLM response onto the context. */
export function trackUsage(ctx: Context, response: LLMResponse): void {
  if (!isMutableContext(ctx)) {
    return;
  }
  ctx.tokens.input += response.usage.inputTokens;
  ctx.tokens.output += response.usage.outputTokens;
  ctx.tokens.total += response.usage.inputTokens + response.usage.outputTokens;
  if (response.cost) {
    ctx.cost = ctx.cost + response.cost;
  }
}
