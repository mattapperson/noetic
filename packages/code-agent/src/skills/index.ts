/**
 * Skills system exports.
 */

export { BUILT_IN_SKILLS } from './built-in/index.js';
export { buildSkillCatalog, getAgent, listAgents } from './catalog.js';
export { discoverSkills, loadSkillFromFile } from './discovery.js';
export { mapFrontmatterToAgentFields, parseFrontmatter } from './frontmatter.js';
export { processSkillContent } from './processor.js';
export type {
  ProcessedInstructionEntry,
  SkillDefinition,
  SkillFrontmatter,
  SkillsLayerState,
} from './types.js';
export { SkillSource } from './types.js';
