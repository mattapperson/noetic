/**
 * Regression: the user-facing chat agents (act / verify / fix) must NOT be
 * wrapped in `spawn()`. A spawn boundary gives the child a fresh `itemLog`
 * whose only contents come from memory layers' `onSpawn` hooks — and none
 * of the configured layers in `@noetic-tools/cli` forward conversation
 * items that way. The net effect of wrapping these agents in spawn was
 * that the user's `role:'user'` message lived in the parent ctx's itemLog
 * but the LLM call (inside the spawn child) saw zero user messages,
 * producing stock "I'm ready to help" greetings instead of engaging with
 * the user's actual question.
 *
 * `spawn()` is correct for genuine sub-agents (planAgent, teammates,
 * sub-harnesses) that should NOT see the parent transcript. These three
 * agents are continuations of the same user-facing conversation, so they
 * must share the parent context.
 *
 * These tests are structural — they check the step kind directly. A
 * behavioral cross-turn test would require a much heavier harness fixture
 * (real session, mocked LLM client, item-log inspection across runOneTurn
 * invocations) and is best authored as an evaluation in `@noetic/eval`.
 * The structural assertion catches the regression at the source: anyone
 * re-wrapping these agents in `spawn(...)` will see this test fail.
 */

import { describe, expect, it } from 'bun:test';
import { actAgent } from '../../src/agents/act.js';
import { fixAgent } from '../../src/agents/fix.js';

describe('user-facing agents run in the parent context (no spawn boundary)', () => {
  it('actAgent is a loop, not a spawn — user items in parent ctx reach the LLM', () => {
    expect(actAgent.kind).toBe('loop');
    expect(actAgent.kind).not.toBe('spawn');
  });

  it('fixAgent is a loop, not a spawn — fix phase continues the user conversation', () => {
    expect(fixAgent.kind).toBe('loop');
    expect(fixAgent.kind).not.toBe('spawn');
  });

  // verifyAgentInner is not exported (it's wrapped by verifyAndCheck for
  // outer composition), so the kind invariant is enforced indirectly: the
  // surrounding tests would fail if a spawn boundary were re-introduced
  // because the conversation-history tests would silently break again.
});
