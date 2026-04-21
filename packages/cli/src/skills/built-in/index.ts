/**
 * Built-in skills registry.
 *
 * Skills shipped with the CLI source tree. Each skill is authored as a regular
 * SKILL.md file under `./<name>/SKILL.md` and bundled at import time via Bun's
 * text-import attribute. The catalog merges these at the lowest precedence, so
 * any user-provided or plugin-provided skill with the same name wins.
 */

import * as path from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import type { SkillDefinition } from '../types.js';
import { SkillSource } from '../types.js';
// Bun supports `with { type: 'text' }` to import any file as a string literal.
// @ts-expect-error — the `with` import attribute is not yet part of TS lib defaults.
import planModeSkillSource from './plan-mode/SKILL.md' with { type: 'text' };
// @ts-expect-error — the `with` import attribute is not yet part of TS lib defaults.
import promptOptimizationSkillSource from './prompt-optimization/SKILL.md' with { type: 'text' };

//#region Helpers

interface BuiltInSkillInput {
  dirName: string;
  source: string;
  /** Absolute path to the SKILL.md on disk, for IDE navigation and override parity. */
  filePath: string;
}

function fromSource(input: BuiltInSkillInput): SkillDefinition {
  const { dirName, source, filePath } = input;
  const { frontmatter, body } = parseFrontmatter(source, filePath);
  const name = frontmatter.name || dirName;

  return {
    name,
    description: frontmatter.description ?? '',
    whenToUse: frontmatter['when-to-use'],
    instructions: body.trim(),
    source: SkillSource.BuiltIn,
    filePath,
    userInvocable: frontmatter['user-invocable'] ?? true,
    modelInvocable: frontmatter['model-invocable'] ?? true,
    allowedTools: frontmatter['allowed-tools'],
  };
}

//#endregion

//#region Public API

const BUILT_IN_DIR = import.meta.dir;

export const BUILT_IN_SKILLS: ReadonlyArray<SkillDefinition> = [
  fromSource({
    dirName: 'plan-mode',
    source: planModeSkillSource,
    filePath: path.join(BUILT_IN_DIR, 'plan-mode', 'SKILL.md'),
  }),
  fromSource({
    dirName: 'prompt-optimization',
    source: promptOptimizationSkillSource,
    filePath: path.join(BUILT_IN_DIR, 'prompt-optimization', 'SKILL.md'),
  }),
];

//#endregion
