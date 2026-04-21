/**
 * /skills command - Lists available skills.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { SkillDefinition } from '../../skills/types.js';
import { SkillSource } from '../../skills/types.js';
import type { Command, LocalJsxCommandCall } from '../types.js';

//#region Types

interface SkillsListProps {
  skills: ReadonlyArray<SkillDefinition>;
  activatedSkills: ReadonlySet<string>;
}

interface SkillGroupProps {
  title: string;
  skills: ReadonlyArray<SkillDefinition>;
  activatedSkills: ReadonlySet<string>;
}

//#endregion

//#region Components

function SkillGroup({ title, skills, activatedSkills }: SkillGroupProps): ReactNode {
  if (skills.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        {title} ({skills.length})
      </Text>
      {skills.map((skill) => {
        const isActive = activatedSkills.has(skill.name);
        return (
          <Box key={skill.name} marginLeft={2}>
            {isActive && <Text color="yellow">[active] </Text>}
            <Text color={isActive ? 'yellow' : 'green'}>/{skill.name}</Text>
            {skill.description && <Text dimColor> — {skill.description}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}

function SkillsList({ skills, activatedSkills }: SkillsListProps): ReactNode {
  // Group skills by source
  const projectSkills = skills.filter((s) => s.source === SkillSource.Project);
  const userSkills = skills.filter((s) => s.source === SkillSource.User);
  const pluginSkills = skills.filter((s) => s.source === SkillSource.Plugin);
  const builtInSkills = skills.filter((s) => s.source === SkillSource.BuiltIn);

  const totalCount = skills.length;
  const activeCount = activatedSkills.size;

  if (totalCount === 0) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text dimColor>No skills available.</Text>
        <Text dimColor>Add skills to .noetic/skills/ or ~/.noetic/skills/</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold>Available Skills ({totalCount})</Text>
      {activeCount > 0 && <Text dimColor>{activeCount} active in this conversation</Text>}
      <Box height={1} />
      <SkillGroup title="Project Skills" skills={projectSkills} activatedSkills={activatedSkills} />
      <SkillGroup title="User Skills" skills={userSkills} activatedSkills={activatedSkills} />
      <SkillGroup title="Plugin Skills" skills={pluginSkills} activatedSkills={activatedSkills} />
      <SkillGroup
        title="Built-in Skills"
        skills={builtInSkills}
        activatedSkills={activatedSkills}
      />
    </Box>
  );
}

//#endregion

//#region Implementation

const call: LocalJsxCommandCall = async (_onDone, ctx, _args) => {
  return <SkillsList skills={ctx.skills} activatedSkills={ctx.activatedSkills} />;
};

//#endregion

//#region Command Definition

export const skills: Command = {
  type: 'local-jsx',
  name: 'skills',
  description: 'List available skills',
  load: async () => ({
    call,
  }),
};

//#endregion
