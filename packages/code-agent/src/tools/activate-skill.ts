/**
 * Skill activation tool.
 *
 * Allows the LLM to activate a skill by name. The actual state update
 * is done by the skills memory layer's store hook, which detects this
 * tool call and adds the skill to activatedSkills.
 */

import { tool } from '@noetic-tools/core';
import { z } from 'zod';

import type { SkillDefinition } from '../skills/types.js';

//#region Schemas

const ActivateSkillInputSchema = z.object({
  name: z.string().describe('The name of the skill to activate'),
});

const ActivateSkillOutputSchema = z.object({
  success: z.boolean().describe('Whether the skill was successfully activated'),
  message: z.string().describe('Status message describing the result'),
});

//#endregion

//#region Types

type ActivateSkillInput = z.infer<typeof ActivateSkillInputSchema>;
type ActivateSkillOutput = z.infer<typeof ActivateSkillOutputSchema>;

export type ActivateSkillTool = ReturnType<typeof createActivateSkillTool>;

//#endregion

//#region Public API

/**
 * Creates the activateSkill tool.
 *
 * @param skills - Array of available skill definitions for validation
 * @returns Tool that activates skills by name
 */
export function createActivateSkillTool(skills: SkillDefinition[]) {
  const skillNames = new Set(skills.filter((s) => s.modelInvocable).map((s) => s.name));

  return tool({
    name: 'activateSkill',
    description:
      'Activate a skill by name to inject its full instructions into context. ' +
      'After calling this tool, the skill instructions will appear in the available_skills section.',
    input: ActivateSkillInputSchema,
    output: ActivateSkillOutputSchema,
    async execute(params: ActivateSkillInput): Promise<ActivateSkillOutput> {
      const { name } = params;

      if (!skillNames.has(name)) {
        return {
          success: false,
          message: `Skill '${name}' not found. Available skills: ${[
            ...skillNames,
          ].join(', ')}`,
        };
      }

      // The actual activation is handled by the skills memory layer's store hook
      // which detects this function call in newItems and updates activatedSkills
      return {
        success: true,
        message: `Skill '${name}' activated. Full instructions will appear in the next response.`,
      };
    },
  });
}

//#endregion
