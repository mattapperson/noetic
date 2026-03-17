/**
 * Skills memory layer — progressive disclosure of skill instructions.
 *
 * Lists all skill names in recall. When the LLM calls activateSkill,
 * the store hook detects it and full instructions appear in the next recall.
 */

import { findFunctionCall } from '../../../src/memory/function-call-utils';
import type { MemoryLayer } from '../../../src/types/memory';
import { Slot } from '../../../src/types/memory';
import type { SkillDefinition, SkillsLayerState } from '../types';

//#region Public API

export function skillsLayer(skills: SkillDefinition[]): MemoryLayer<SkillsLayerState> {
  return {
    id: 'skills-memory',
    slot: Slot.PROCEDURAL,
    scope: 'execution',
    budget: {
      min: 300,
      max: 2_000,
    },
    hooks: {
      async init() {
        return {
          state: {
            definitions: skills,
            activatedSkills: [],
          },
        };
      },

      async recall({ state }) {
        if (!state?.definitions?.length) {
          return null;
        }

        const sections: string[] = [];
        sections.push('<available_skills>');

        for (const skill of state.definitions) {
          const isActivated = state.activatedSkills.includes(skill.name);
          sections.push(`\n## ${skill.name}`);
          sections.push(skill.description);

          if (isActivated) {
            sections.push(`\n### Instructions\n${skill.instructions}`);
          }
        }

        sections.push('\n</available_skills>');
        sections.push('\nTo activate a skill, call activateSkill({ name: "skill-name" }).');

        return sections.join('\n');
      },

      async store({ newItems, state }) {
        const args = findFunctionCall(newItems, 'activateSkill');
        if (!args) {
          return;
        }
        const name = args.name;
        if (typeof name !== 'string') {
          return;
        }
        const exists = state.definitions.some((d) => d.name === name);
        if (!exists) {
          return;
        }
        if (state.activatedSkills.includes(name)) {
          return;
        }
        return {
          state: {
            ...state,
            activatedSkills: [
              ...state.activatedSkills,
              name,
            ],
          },
        };
      },

      async onSpawn({ parentState }) {
        return {
          childState: structuredClone(parentState),
        };
      },
    },
  };
}

//#endregion
