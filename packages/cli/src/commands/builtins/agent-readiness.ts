/**
 * /agent-readiness — ports claude-code's NEW_INIT_PROMPT into a local slash
 * command that submits an 8-phase setup prompt to the harness as a user turn.
 *
 * Source attribution: https://github.com/anthropics/claude-code
 */

import type { Command, LocalCommandCall, LocalCommandResult } from '../types.js';
// Bun's `with { type: 'text' }` lets us import .md as a raw string — same
// pattern as `src/skills/built-in/index.ts`.
// @ts-expect-error — the `with` import attribute is not yet part of TS lib defaults.
import agentReadinessPromptSource from './agent-readiness.md' with { type: 'text' };

//#region Prompt

export const AGENT_READINESS_PROMPT = agentReadinessPromptSource;

//#endregion

//#region Implementation

const call: LocalCommandCall = async (): Promise<LocalCommandResult> => ({
  type: 'prompt',
  value: AGENT_READINESS_PROMPT,
});

//#endregion

//#region Command Definition

export const agentReadiness: Command = {
  type: 'local',
  name: 'agent-readiness',
  description: 'Initialize CLAUDE.md (and optional skills/hooks) with codebase documentation',
  load: async () => ({
    call,
  }),
};

//#endregion
