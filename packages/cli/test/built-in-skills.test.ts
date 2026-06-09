import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLocalFsAdapter } from '@noetic-tools/platform-node';

import { createPluginContextBuilder } from '../src/plugins/context.js';
import { BUILT_IN_SKILLS } from '../src/skills/built-in/index.js';
import { buildSkillCatalog } from '../src/skills/catalog.js';
import { SkillSource } from '../src/skills/types.js';
import type { AgentConfig } from '../src/types/config.js';

const testFs = createLocalFsAdapter();

//#region Helpers

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'noetic-builtin-skills-test-'));
}

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, {
    recursive: true,
    force: true,
  });
}

async function writeUserPlanModeSkill(baseDir: string, body: string): Promise<void> {
  const skillDir = path.join(baseDir, '.noetic', 'skills', 'plan-mode');
  await fs.mkdir(skillDir, {
    recursive: true,
  });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), body);
}

/**
 * Real PluginContextBuilder, since we pass plugins=[] the builder is never
 * invoked — but buildSkillCatalog's signature still requires the concrete type.
 */
function makeBuildCtx(cwd: string) {
  const config: AgentConfig = {
    model: 'test-model',
    apiKey: 'test-key',
    cwd,
    maxTurns: 1,
    plugins: [],
  };
  return createPluginContextBuilder(config);
}

//#endregion

//#region BUILT_IN_SKILLS

describe('BUILT_IN_SKILLS registry', () => {
  test('includes the plan-mode skill', () => {
    const planMode = BUILT_IN_SKILLS.find((s) => s.name === 'plan-mode');
    expect(planMode).toBeDefined();
  });

  test('plan-mode skill is marked as built-in', () => {
    const planMode = BUILT_IN_SKILLS.find((s) => s.name === 'plan-mode');
    expect(planMode?.source).toBe(SkillSource.BuiltIn);
  });

  test('plan-mode skill is model-invocable but not user-invocable', () => {
    // model-invocable: true so the model can activateSkill({name: 'plan-mode'})
    //   to learn FlowSchema outside plan mode (inside plan mode the content is
    //   auto-injected via additionalPlanInstructions regardless).
    // user-invocable: false because plan mode is entered via /plan, not via
    //   the skill's user slash command.
    const planMode = BUILT_IN_SKILLS.find((s) => s.name === 'plan-mode');
    expect(planMode?.userInvocable).toBe(false);
    expect(planMode?.modelInvocable).toBe(true);
  });

  test('plan-mode instructions mention the FlowSchema and plan/updatePrd tool', () => {
    // Smoke check against silent content drift — if these strings disappear,
    // the skill has regressed to shallow guidance and plan-mode will once
    // again push the model to explore source code.
    const planMode = BUILT_IN_SKILLS.find((s) => s.name === 'plan-mode');
    expect(planMode?.instructions).toContain('FlowSchema');
    expect(planMode?.instructions).toContain('plan/updatePrd');
    expect(planMode?.instructions).toContain('plan/setPlanTree');
    expect(planMode?.instructions).toContain('plan/exitPlanMode');
  });

  test('plan-mode skill has a non-empty description', () => {
    const planMode = BUILT_IN_SKILLS.find((s) => s.name === 'plan-mode');
    expect(planMode?.description.length ?? 0).toBeGreaterThan(0);
  });
});

//#endregion

//#region buildSkillCatalog precedence

describe('buildSkillCatalog precedence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanup(tempDir);
  });

  test('includes the built-in plan-mode skill when no filesystem override exists', async () => {
    const skills = await buildSkillCatalog({
      cwd: tempDir,
      plugins: [],
      fs: testFs,
      buildCtx: makeBuildCtx(tempDir),
    });

    const planMode = skills.find((s) => s.name === 'plan-mode');
    expect(planMode).toBeDefined();
    expect(planMode?.source).toBe(SkillSource.BuiltIn);
  });

  test('filesystem skill at .noetic/skills/plan-mode overrides the built-in', async () => {
    const userSkill = `---
name: plan-mode
description: Custom plan mode override
---

# Custom content

This replaces the built-in plan-mode guidance.
`;
    await writeUserPlanModeSkill(tempDir, userSkill);

    const skills = await buildSkillCatalog({
      cwd: tempDir,
      plugins: [],
      fs: testFs,
      buildCtx: makeBuildCtx(tempDir),
    });

    const planMode = skills.find((s) => s.name === 'plan-mode');
    expect(planMode).toBeDefined();
    expect(planMode?.source).toBe(SkillSource.Project);
    expect(planMode?.description).toBe('Custom plan mode override');
    expect(planMode?.instructions).toContain('This replaces the built-in plan-mode guidance.');
    // Content from the built-in should no longer be present.
    expect(planMode?.instructions).not.toContain('FlowSchema');
  });

  test('does not duplicate plan-mode across sources', async () => {
    await writeUserPlanModeSkill(
      tempDir,
      `---
name: plan-mode
description: Override
---

Body.
`,
    );
    const skills = await buildSkillCatalog({
      cwd: tempDir,
      plugins: [],
      fs: testFs,
      buildCtx: makeBuildCtx(tempDir),
    });
    const planModes = skills.filter((s) => s.name === 'plan-mode');
    expect(planModes).toHaveLength(1);
  });
});

//#endregion
