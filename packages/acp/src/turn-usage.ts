/**
 * What an agent's `session/prompt` answer says the turn cost. ACP's `usage` is
 * specified as the session's running total, so the runtime charges nothing
 * from it on its own; an agent whose bridge reports each turn's own figures
 * reads them here, as its preset's `usageOf`.
 */

import type * as acp from '@agentclientprotocol/sdk';
import type { TokenUsage } from '@noetic-tools/types';

/** @public Reads a turn's tokens from the agent's answer to it. */
export type TurnUsageOf = (answer: acp.PromptResponse) => TokenUsage | undefined;

/** A count the agent reported: a whole number, at least zero. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * claude-agent-acp: `usage` is the turn's own, and its `inputTokens` leave out
 * the tokens read from and written to the cache, as Anthropic counts them.
 */
export const claudeTurnUsage: TurnUsageOf = (answer) => {
  const usage = answer.usage;
  const input = count(usage?.inputTokens);
  const output = count(usage?.outputTokens);
  if (input === undefined || output === undefined) {
    return undefined;
  }
  const read = count(usage?.cachedReadTokens);
  const written = count(usage?.cachedWriteTokens) ?? 0;
  const all = input + (read ?? 0) + written;
  return {
    input: all,
    output,
    total: all + output,
    ...(read === undefined
      ? {}
      : {
          cached: read,
        }),
  };
};

/**
 * codex-acp: `usage` is the prompt's own, and its `inputTokens` already count
 * the cached ones, as OpenAI counts them.
 */
export const codexTurnUsage: TurnUsageOf = (answer) => {
  const usage = answer.usage;
  const input = count(usage?.inputTokens);
  const output = count(usage?.outputTokens);
  if (input === undefined || output === undefined) {
    return undefined;
  }
  const read = count(usage?.cachedReadTokens);
  return {
    input,
    output,
    total: input + output,
    ...(read === undefined
      ? {}
      : {
          cached: read,
        }),
  };
};
