/**
 * Built-in skills registry.
 *
 * Skills shipped with the CLI source tree. Each skill is authored as a regular
 * SKILL.md file under `./<name>/SKILL.md` and bundled at import time via Bun's
 * text-import attribute. The catalog merges these at the lowest precedence, so
 * any user-provided or plugin-provided skill with the same name wins.
 */

import * as path from 'node:path';
import { mapFrontmatterToAgentFields, parseFrontmatter } from '../frontmatter.js';
import type { SkillDefinition } from '../types.js';
import { SkillSource } from '../types.js';
// Bun supports `with { type: 'text' }` to import any file as a string literal.
// @ts-expect-error — the `with` import attribute is not yet part of TS lib defaults.
import exploreAgentSource from './explore/SKILL.md' with { type: 'text' };
// @ts-expect-error — the `with` import attribute is not yet part of TS lib defaults.
import generalPurposeAgentSource from './general-purpose/SKILL.md' with { type: 'text' };
// @ts-expect-error — the `with` import attribute is not yet part of TS lib defaults.
import planAgentSource from './plan/SKILL.md' with { type: 'text' };
// @ts-expect-error — the `with` import attribute is not yet part of TS lib defaults.
import planModeSkillSource from './plan-mode/SKILL.md' with { type: 'text' };
// @ts-expect-error — the `with` import attribute is not yet part of TS lib defaults.
import promptOptimizationSkillSource from './prompt-optimization/SKILL.md' with { type: 'text' };
// @ts-expect-error — the `with` import attribute is not yet part of TS lib defaults.
import verificationAgentSource from './verification/SKILL.md' with { type: 'text' };

//#region Helpers

interface BuiltInSkillInput {
  dirName: string;
  source: string;
}

function fromSource(input: BuiltInSkillInput): SkillDefinition {
  const filePath = path.join(BUILT_IN_DIR, input.dirName, 'SKILL.md');
  const { frontmatter, body } = parseFrontmatter(input.source, filePath);
  const name = frontmatter.name || input.dirName;

  return {
    name,
    description: frontmatter.description ?? '',
    whenToUse: frontmatter['when-to-use'] ?? undefined,
    instructions: body.trim(),
    source: SkillSource.BuiltIn,
    filePath,
    userInvocable: frontmatter['user-invocable'] ?? true,
    modelInvocable: frontmatter['model-invocable'] ?? true,
    allowedTools: frontmatter['allowed-tools'] ?? undefined,
    ...mapFrontmatterToAgentFields(frontmatter),
  };
}

//#endregion

//#region Public API

const BUILT_IN_DIR = import.meta.dir;

const BUILT_IN_INPUTS: ReadonlyArray<BuiltInSkillInput> = [
  {
    dirName: 'plan-mode',
    source: planModeSkillSource,
  },
  {
    dirName: 'general-purpose',
    source: generalPurposeAgentSource,
  },
  {
    dirName: 'explore',
    source: exploreAgentSource,
  },
  {
    dirName: 'plan',
    source: planAgentSource,
  },
  {
    dirName: 'verification',
    source: verificationAgentSource,
  },
  {
    dirName: 'prompt-optimization',
    source: promptOptimizationSkillSource,
  },
];

export const BUILT_IN_SKILLS: ReadonlyArray<SkillDefinition> = BUILT_IN_INPUTS.map(fromSource);

//#endregion
