/**
 * Regression: lock in the spawn-boundary placement across the three inner
 * agents. The bug was that `actAgent` was wrapped in `spawn()`: the spawn
 * gives the child a fresh `itemLog` whose only contents come from memory
 * layers' `onSpawn` hooks, and no configured layer forwards conversation
 * items. The user's `role:'user'` message lived in the parent ctx but the
 * LLM call (inside the spawn child) saw zero user messages — the model
 * just regurgitated system context.
 *
 * The fix is asymmetric on purpose:
 *
 *   - `actAgent`     → NOT spawned. It IS the user-facing conversation;
 *                       its LLM call MUST see the user message + history.
 *   - `verifyAgent`  → STAYS spawned. The adversarial reviewer never reads
 *                       the user turn (static instructions, read-only
 *                       tools); keeping it isolated holds its PASS/FAIL +
 *                       tool-call noise out of the user-facing transcript.
 *   - `fixAgent`     → STAYS spawned. Same rationale — fixer reads from
 *                       flow-state `verifyFindings`, not the itemLog.
 *
 * These structural checks catch any future re-wrap at the source. A
 * behavioral cross-turn test that drives a real two-turn session through
 * `AgentHarness.execute` would be the natural complement and is the right
 * shape for an `@noetic/eval` regression — pilotty verification under
 * /Users/ian/src/github/mattapperson/noetic/.claude/worktrees/cli-submission-stuck
 * confirms the chain works end-to-end ("what is 2 + 3?" → "2 + 3 = 5";
 * "now multiply that by 4" → "5 × 4 = 20"), so the unit-level invariants
 * here are the long-term guard.
 */

import { describe, expect, it } from 'bun:test';
import { actAgent } from '../../src/agents/act.js';
import { fixAgent } from '../../src/agents/fix.js';
import { verifyAgent } from '../../src/agents/verify.js';

describe('act/verify/fix spawn-boundary invariants', () => {
  it('actAgent is a loop, not a spawn — user items in parent ctx reach the LLM', () => {
    expect(actAgent.kind).toBe('loop');
    expect(actAgent.kind).not.toBe('spawn');
  });

  it('verifyAgent stays spawned — adversarial PASS/FAIL output must NOT enter the user transcript', () => {
    expect(verifyAgent.kind).toBe('spawn');
  });

  it('fixAgent stays spawned — fix tool-call noise must NOT enter the user transcript', () => {
    expect(fixAgent.kind).toBe('spawn');
  });
});
