/**
 * Skills memory layer — progressive disclosure of skill instructions.
 *
 * Lists all skill names in recall. When the LLM calls activateSkill,
 * the store hook detects it and full instructions appear in the next recall.
 * Inline shell commands (!) are executed when skills are first activated.
 */

import type { FunctionCallItem, Item, MemoryLayer } from '@noetic/core';
import { Slot } from '@noetic/core';

import { processSkillContent } from '../skills/processor.js';
import type {
  ProcessedInstructionEntry,
  SkillDefinition,
  SkillsLayerState,
} from '../skills/types.js';

//#region Constants

/** Maximum number of processed instructions to cache (LRU eviction when exceeded) */
const MAX_CACHE_SIZE = 50;

//#endregion

//#region Type Guards

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFunctionCall(item: Item): item is FunctionCallItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'function_call' &&
    'name' in item &&
    'arguments' in item
  );
}

//#endregion

//#region Helpers

/**
 * Finds the first function_call item matching `name`, parses its JSON arguments,
 * and returns the result as a record. Returns null if no match or invalid data.
 */
function findFunctionCall(
  items: ReadonlyArray<Item>,
  name: string,
): Record<string, unknown> | null {
  for (const item of items) {
    if (!isFunctionCall(item)) {
      continue;
    }
    if (item.name !== name) {
      continue;
    }
    try {
      const raw = JSON.parse(item.arguments);
      if (!isRecord(raw)) {
        continue;
      }
      return raw;
    } catch {
      // Invalid JSON, skip
    }
  }
  return null;
}

function createInitialState(definitions: SkillDefinition[]): SkillsLayerState {
  return {
    definitions,
    activatedSkills: [],
    processedInstructions: new Map(),
  };
}

/**
 * Evicts least recently used entries from the cache if it exceeds MAX_CACHE_SIZE.
 * Returns a new Map with evicted entries removed.
 */
function evictLruEntries(
  cache: Map<string, ProcessedInstructionEntry>,
): Map<string, ProcessedInstructionEntry> {
  if (cache.size <= MAX_CACHE_SIZE) {
    return cache;
  }

  // Sort entries by lastAccess (oldest first)
  const entries = [
    ...cache.entries(),
  ].sort((a, b) => a[1].lastAccess - b[1].lastAccess);

  // Keep only the most recent MAX_CACHE_SIZE entries
  const toKeep = entries.slice(entries.length - MAX_CACHE_SIZE);
  return new Map(toKeep);
}

//#endregion

//#region Public API

export interface SkillsLayerConfig {
  /** Current working directory for inline command execution */
  cwd: string;
}

export function skillsLayer(
  skills: SkillDefinition[],
  config: SkillsLayerConfig,
): MemoryLayer<SkillsLayerState> {
  const { cwd } = config;

  return {
    id: 'skills-memory',
    name: 'Skills Memory',
    slot: Slot.PROCEDURAL,
    scope: 'execution',
    budget: {
      min: 300,
      max: 2_000,
    },
    hooks: {
      async init() {
        return {
          state: createInitialState(skills),
        };
      },

      async recall({ state }) {
        if (!state?.definitions?.length) {
          return null;
        }

        const sections: string[] = [];
        sections.push('<available_skills>');

        // List all model-invocable skills with descriptions
        for (const skill of state.definitions) {
          if (!skill.modelInvocable) {
            continue;
          }
          sections.push(`\n## ${skill.name}`);
          sections.push(skill.description);
          if (skill.whenToUse) {
            sections.push(`_When to use: ${skill.whenToUse}_`);
          }

          // Show full instructions for activated skills (already processed in store hook)
          if (state.activatedSkills.includes(skill.name)) {
            const entry = state.processedInstructions.get(skill.name);
            if (entry) {
              sections.push(`\n### Instructions\n${entry.content}`);
            } else {
              // Fallback to raw instructions if not yet processed (shouldn't happen normally)
              sections.push(`\n### Instructions\n${skill.instructions}`);
            }
          }
        }

        sections.push('\n</available_skills>');
        sections.push(
          '\nTo activate a skill and see its full instructions, call activateSkill({ name: "skill-name" }).',
        );

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

        const skill = state.definitions.find((d) => d.name === name && d.modelInvocable);
        if (!skill) {
          return;
        }

        if (state.activatedSkills.includes(name)) {
          return;
        }

        // Process instructions now (during store, not recall) to avoid mutation during recall
        let processedInstructions = new Map(state.processedInstructions);
        if (!processedInstructions.has(name)) {
          const processed = await processSkillContent(skill.instructions, cwd);
          processedInstructions.set(name, {
            content: processed,
            lastAccess: Date.now(),
          });
          // Evict LRU entries if cache is too large
          processedInstructions = evictLruEntries(processedInstructions);
        } else {
          // Update access time for existing entry
          const existing = processedInstructions.get(name);
          if (existing) {
            processedInstructions.set(name, {
              ...existing,
              lastAccess: Date.now(),
            });
          }
        }

        return {
          state: {
            ...state,
            activatedSkills: [
              ...state.activatedSkills,
              name,
            ],
            processedInstructions,
          },
        };
      },

      async onSpawn({ parentState }) {
        // Children inherit activated skills and processed cache
        return {
          childState: {
            ...parentState,
            definitions: [
              ...parentState.definitions,
            ],
            activatedSkills: [
              ...parentState.activatedSkills,
            ],
            processedInstructions: new Map(parentState.processedInstructions),
          },
        };
      },
    },
  };
}

//#endregion
