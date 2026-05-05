/**
 * Ask-user tool — pauses the agent mid-turn to pose structured questions to
 * the human operator and return their answers.
 *
 * Execution delegates to an `AskUserService` (in-memory pending-request store)
 * provided by the TUI. Without a service, the tool is not registered — a
 * headless harness has no way to render the modal.
 */

import type { Tool } from '@noetic/core';
import { AskUserInputSchema, AskUserOutputSchema, tool } from '@noetic/core';
import type { z } from 'zod';

export interface AskUserService {
  request(input: z.infer<typeof AskUserInputSchema>): Promise<z.infer<typeof AskUserOutputSchema>>;
}

//#region Description

const ASK_USER_DESCRIPTION = `Ask the human user one to four structured multiple-choice questions mid-turn.

Use this tool when:
 - You need a decision from the user before proceeding (clarifying requirements, picking between approaches, gathering preferences).
 - You would otherwise have to guess and risk doing the wrong work.

Usage notes:
 - Provide 1–4 questions. Each question has 2–4 options (the "Other" free-text option is added automatically).
 - Keep \`header\` to 12 characters or fewer — it is shown as a chip on the question tab.
 - Set \`multiSelect: true\` only when choices are not mutually exclusive.
 - If you recommend an option, put it first and append "(Recommended)" to its label.
 - Use the optional \`preview\` field on options when presenting concrete artifacts to compare (ASCII mockups, code snippets, diagrams, config examples). Preview content renders as markdown (HTML fragments are also accepted). Do not use previews for simple preference questions.
 - Previews are only rendered for single-select questions (not multiSelect).
 - Do NOT ask questions whose answers you can discover by reading the code. Ask for user intent, not facts.

The tool returns a map of \`question -> answer\`. Any question the user marks as "Other" returns their free-text input.`;

//#endregion

//#region Public API

export type AskUserTool = Tool<typeof AskUserInputSchema, typeof AskUserOutputSchema>;

export function createAskUserTool(service: AskUserService): AskUserTool {
  return tool({
    name: 'AskUserQuestion',
    description: ASK_USER_DESCRIPTION,
    input: AskUserInputSchema,
    output: AskUserOutputSchema,
    async execute(params) {
      return service.request(params);
    },
  });
}

//#endregion
