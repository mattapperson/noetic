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

/** @public Input message item narrowed to the `user` role. */
export type UserMessageItem = InputMessageItem & {
  readonly role: 'user';
};

export function isUserMessage(item: unknown): item is UserMessageItem {
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

/** Extracts assistant/output text from items for context buffering (one string per message). */
export function collectOutputText(items: ReadonlyArray<Item>): string[] {
  return items
    .filter(isAssistantMessage)
    .map((i) =>
      i.content
        .filter(isOutputText)
        .map((c: { text: string }) => c.text)
        .join(''),
    )
    .filter((t) => t.length > 0);
}

/**
 * Extracts text from INPUT items for context buffering: concatenates the text
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

/** @public One unit of spend to charge to a context: a model call, or any other billed work. */
export interface UsageCharge {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  /** USD. */
  cost?: number;
}

function addCharge(ctx: UsageMutableContext, charge: UsageCharge): void {
  ctx.tokens.input += charge.inputTokens;
  ctx.tokens.output += charge.outputTokens;
  ctx.tokens.total += charge.inputTokens + charge.outputTokens;
  // Only write `cached` when the charge actually carried a figure. Defaulting
  // a missing report to 0 would erase the `RoundUsage` invariant that
  // `undefined` means "this provider says nothing about caching" — callers that
  // steer on cache behaviour could no longer tell that from "nothing was
  // cached".
  if (charge.cachedTokens !== undefined) {
    ctx.tokens.cached = (ctx.tokens.cached ?? 0) + charge.cachedTokens;
  }
  if (charge.cost) {
    ctx.cost = ctx.cost + charge.cost;
  }
}

function usageParentOf(ctx: Context): Context | null {
  return ctx.usageParent !== undefined ? ctx.usageParent : ctx.parent;
}

/**
 * @public Charge `charge` to `ctx` and to every ancestor on its `usageParent`
 * chain. Charging at the moment of spend — rather than merging a child's
 * totals into its parent when the child settles — is what keeps spend from a
 * failed spawn, a fork path, or an abandoned `race` loser from being lost, and
 * lets `until.maxCost` / `checkBudget` on an ancestor see siblings' spend live.
 * Use this, not direct writes to `ctx.cost`, for any billed work outside a
 * model call; a direct write stays on that one context.
 */
export function recordUsage(ctx: Context, charge: UsageCharge): void {
  // The chain is acyclic for every ContextImpl (parents are fixed at
  // construction); the guard only protects against a hand-rolled Context.
  const seen = new Set<Context>();
  for (let current: Context | null = ctx; current && !seen.has(current); ) {
    seen.add(current);
    if (canTrackUsage(current)) {
      addCharge(current, charge);
    }
    current = usageParentOf(current);
  }
}

/** Accumulate token usage and cost from an LLM response onto a context and its usage ancestors. */
export function trackUsage(ctx: Context, response: LLMResponse): void {
  recordUsage(ctx, {
    ...response.usage,
    cost: response.cost,
  });
}
