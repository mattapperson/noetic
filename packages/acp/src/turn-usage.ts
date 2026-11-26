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
 * The turn's own `usage`, as claude-agent-acp and codex-acp report it: both
 * tally the turn alone, and both leave the tokens read from and written to the
 * cache out of `inputTokens`, so they are added back to make the turn's input.
 * @public
 */
export const turnUsage: TurnUsageOf = (answer) => {
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
