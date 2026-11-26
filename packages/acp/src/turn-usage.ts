/**
 * What an agent's `session/prompt` answer says the turn cost. ACP's `usage` is
 * specified as the session's running total, so the runtime charges nothing
 * from it on its own; an agent whose bridge reports each turn's own figures
 * reads them here, as its preset's `usageOf`.
 */

import type * as acp from '@agentclientprotocol/sdk';
import type { RoundUsage } from '@noetic-tools/types';

/** @public Reads a turn's tokens from the agent's answer to it. */
export type TurnUsageOf = (answer: acp.PromptResponse) => RoundUsage | undefined;

/** A count the agent reported: a whole number, at least zero. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The turn's own `usage`, as claude-agent-acp and codex-acp report it: both
 * tally the turn alone, and both leave the tokens read from and written to the
 * cache out of `inputTokens`, so they are added back to make the turn's input,
 * as a model round counts it.
 * @public
 */
export const turnUsage: TurnUsageOf = (answer) => {
  const usage = answer.usage;
  const input = count(usage?.inputTokens);
  const outputTokens = count(usage?.outputTokens);
  if (input === undefined || outputTokens === undefined) {
    return undefined;
  }
  const cachedTokens = count(usage?.cachedReadTokens);
  const cacheWriteTokens = count(usage?.cachedWriteTokens);
  return {
    inputTokens: input + (cachedTokens ?? 0) + (cacheWriteTokens ?? 0),
    outputTokens,
    ...(cachedTokens === undefined
      ? {}
      : {
          cachedTokens,
        }),
    ...(cacheWriteTokens === undefined
      ? {}
      : {
          cacheWriteTokens,
        }),
  };
};
