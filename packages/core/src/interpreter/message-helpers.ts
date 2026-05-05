import type { LLMResponse } from '../types/common';
import type { Context } from '../types/context';
import { isMutableContext } from './typeguards';

/** Accumulate token usage and cost from an LLM response onto the context. */
export function trackUsage(ctx: Context, response: LLMResponse): void {
  if (!isMutableContext(ctx)) {
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
