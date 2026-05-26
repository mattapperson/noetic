import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLocalFsAdapter, createLocalShellAdapter } from '@noetic/platform-node';

import { discoverSkills } from '../src/skills/discovery.js';
import type { SkillDefinition } from '../src/skills/types.js';
import { SkillSource } from '../src/skills/types.js';
import { processSkillContent } from '../src/util/skill-processor.js';

const testFs = createLocalFsAdapter();
const testShell = createLocalShellAdapter();

//#region Test Helpers

async function createTempDir(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'noetic-skills-test-'));
  return tmpDir;
}

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, {
    recursive: true,
    force: true,
  });
}

async function createSkillFile(
  baseDir: string,
  skillName: string,
  content: string,
): Promise<string> {
  const skillDir = path.join(baseDir, '.noetic', 'skills', skillName);
  await fs.mkdir(skillDir, {
    recursive: true,
  });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(skillPath, content);
  return skillPath;
}

//#endregion

//#region Discovery Tests

describe('discoverSkills', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanup(tempDir);
  });

  test('discovers skill from .noetic/skills directory', async () => {
    const skillContent = `---
name: test-skill
description: A test skill
when-to-use: When testing
---

# Test Skill Instructions

Do something useful.
`;

    await createSkillFile(tempDir, 'test-skill', skillContent);

    const skills = await discoverSkills(tempDir, testFs);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('test-skill');
    expect(skills[0].description).toBe('A test skill');
    expect(skills[0].whenToUse).toBe('When testing');
    expect(skills[0].source).toBe(SkillSource.Project);
    expect(skills[0].instructions).toContain('Test Skill Instructions');
    expect(skills[0].userInvocable).toBe(true);
    expect(skills[0].modelInvocable).toBe(true);
  });

  test('uses directory name when name not in frontmatter', async () => {
    const skillContent = `---
description: A nameless skill
---

Instructions here.
`;

    await createSkillFile(tempDir, 'from-dir-name', skillContent);

    const skills = await discoverSkills(tempDir, testFs);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('from-dir-name');
  });

  test('handles skill without frontmatter', async () => {
    const skillContent = `# Plain Skill

No frontmatter here.
`;

    await createSkillFile(tempDir, 'plain-skill', skillContent);

    const skills = await discoverSkills(tempDir, testFs);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('plain-skill');
    expect(skills[0].instructions).toContain('Plain Skill');
  });

  test('discovers from .agent/skills as fallback', async () => {
    const skillDir = path.join(tempDir, '.agent', 'skills', 'agent-skill');
    await fs.mkdir(skillDir, {
      recursive: true,
    });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: agent-skill
description: From agent folder
---

Instructions.
`,
    );

    const skills = await discoverSkills(tempDir, testFs);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('agent-skill');
    expect(skills[0].source).toBe(SkillSource.Project);
  });

  test('.noetic skills take priority over .agent skills', async () => {
    // Create skill in .noetic
    await createSkillFile(
      tempDir,
      'priority-skill',
      `---
name: priority-skill
description: From noetic
---

Noetic version.
`,
    );

    // Create same skill in .agent
    const agentDir = path.join(tempDir, '.agent', 'skills', 'priority-skill');
    await fs.mkdir(agentDir, {
      recursive: true,
    });
    await fs.writeFile(
      path.join(agentDir, 'SKILL.md'),
      `---
name: priority-skill
description: From agent
---

Agent version.
`,
    );

    const skills = await discoverSkills(tempDir, testFs);

    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('From noetic');
  });

  test('returns empty array when no skills exist', async () => {
    const skills = await discoverSkills(tempDir, testFs);
    expect(skills).toHaveLength(0);
  });

  test('parses userInvocable and modelInvocable flags', async () => {
    const skillContent = `---
name: restricted-skill
description: A restricted skill
user-invocable: false
model-invocable: true
---

Instructions.
`;

    await createSkillFile(tempDir, 'restricted-skill', skillContent);

    const skills = await discoverSkills(tempDir, testFs);

    expect(skills).toHaveLength(1);
    expect(skills[0].userInvocable).toBe(false);
    expect(skills[0].modelInvocable).toBe(true);
  });

  test('parses allowed-tools array', async () => {
    const skillContent = `---
name: limited-skill
description: Limited tools
allowed-tools:
  - read
  - grep
---

Instructions.
`;

    await createSkillFile(tempDir, 'limited-skill', skillContent);

    const skills = await discoverSkills(tempDir, testFs);

    expect(skills).toHaveLength(1);
    expect(skills[0].allowedTools).toEqual([
      'read',
      'grep',
    ]);
  });
});

//#endregion

//#region Processor Tests

describe('processSkillContent', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanup(tempDir);
  });

  test('returns content unchanged when no commands', async () => {
    const content = `# Simple Skill

No commands here.
`;

    const result = await processSkillContent(content, tempDir, testShell);

    expect(result).toBe(content);
  });

  test('executes inline shell command and replaces with output', async () => {
    const content = `Current branch:
!echo "test-output"

More content.
`;

    const result = await processSkillContent(content, tempDir, testShell);

    expect(result).toContain('test-output');
    expect(result).not.toContain('!echo');
  });

  test('preserves indentation for command output', async () => {
    const content = `  !echo "indented"`;

    const result = await processSkillContent(content, tempDir, testShell);

    expect(result).toContain('  indented');
  });

  test('wraps multiline output in code blocks', async () => {
    const content = `!echo -e "line1\\nline2"`;

    const result = await processSkillContent(content, tempDir, testShell);

    expect(result).toContain('```');
  });

  test('handles command errors gracefully', async () => {
    const content = '!exit 1';

    const result = await processSkillContent(content, tempDir, testShell);

    expect(result).toContain('error executing');
  });

  test('shows (no output) for empty command output', async () => {
    // Create empty file to cat
    await fs.writeFile(path.join(tempDir, 'empty.txt'), '');

    const content = `!cat ${path.join(tempDir, 'empty.txt')}`;

    const result = await processSkillContent(content, tempDir, testShell);

    expect(result).toContain('(no output)');
  });

  test('executes commands in specified cwd', async () => {
    // Create a nested directory with a file
    const nestedDir = path.join(tempDir, 'nested');
    await fs.mkdir(nestedDir);
    await fs.writeFile(path.join(nestedDir, 'marker.txt'), 'found-it');

    const content = '!cat marker.txt';

    const result = await processSkillContent(content, nestedDir, testShell);

    expect(result).toContain('found-it');
  });
});

//#endregion

//#region Skills Layer State Tests

describe('SkillsLayerState', () => {
  test('SkillDefinition type has required fields', () => {
    const skill: SkillDefinition = {
      name: 'test',
      description: 'Test skill',
      instructions: 'Do stuff',
      source: SkillSource.Project,
      filePath: '/path/to/skill',
      userInvocable: true,
      modelInvocable: true,
    };

    expect(skill.name).toBe('test');
    expect(skill.source).toBe('project');
  });

  test('SkillSource enum has correct values', () => {
    expect(SkillSource.Project).toBe('project');
    expect(SkillSource.User).toBe('user');
    expect(SkillSource.Plugin).toBe('plugin');
  });
});

//#endregion
