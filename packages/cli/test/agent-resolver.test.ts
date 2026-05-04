import { describe, expect, test } from 'bun:test';
import type { Tool } from '@noetic/core';
import { tool } from '@noetic/core';
import { z } from 'zod';
import type { SkillDefinition } from '../src/skills/types.js';
import { SkillSource } from '../src/skills/types.js';
import { resolveAgent } from '../src/tools/agent.js';
import type { AgentOverride } from '../src/types/config.js';

function makeSkill(opts: {
  agentType: string;
  agentModel?: string;
  allowedTools?: ReadonlyArray<string>;
  instructions?: string;
  agentBackground?: boolean;
}): SkillDefinition {
  return {
    name: opts.agentType,
    description: `${opts.agentType} desc`,
    instructions: opts.instructions ?? `body of ${opts.agentType}`,
    source: SkillSource.BuiltIn,
    filePath: null,
    userInvocable: true,
    modelInvocable: true,
    agentType: opts.agentType,
    agentModel: opts.agentModel,
    allowedTools: opts.allowedTools,
    agentBackground: opts.agentBackground,
  };
}

const StubInputSchema = z.object({});
const StubOutputSchema = z.object({});

function makeTool(name: string): Tool {
  return tool({
    name,
    description: `${name} tool`,
    input: StubInputSchema,
    output: StubOutputSchema,
    execute: async () => {
      throw new Error('not invoked');
    },
  });
}

const PARENT_TOOLS: ReadonlyArray<Tool> = [
  makeTool('read'),
  makeTool('grep'),
  makeTool('write'),
  makeTool('bash'),
];

const PARENT_MODEL = 'parent/model';

interface RunResolveArgs {
  skill: SkillDefinition;
  overrides?: Record<string, AgentOverride>;
  inputModel?: string;
  runInBackground?: boolean;
}

function runResolve(args: RunResolveArgs) {
  return resolveAgent({
    input: {
      description: 'desc',
      prompt: 'do the thing',
      subagent_type: args.skill.agentType,
      model: args.inputModel,
      run_in_background: args.runInBackground,
    },
    catalog: [
      args.skill,
    ],
    parentTools: PARENT_TOOLS,
    parentModel: PARENT_MODEL,
    agentOverrides: args.overrides,
  });
}

describe('resolveAgent — model precedence', () => {
  test('skill agentModel="inherit" + no override → parent model wins', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'explore',
        agentModel: 'inherit',
      }),
    });
    expect(resolved.model).toBe(PARENT_MODEL);
  });

  test('skill agentModel set + no override → skill model wins', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'explore',
        agentModel: 'moonshotai/kimi-latest',
      }),
    });
    expect(resolved.model).toBe('moonshotai/kimi-latest');
  });

  test('config override beats skill model (even when skill model is set)', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'explore',
        agentModel: 'moonshotai/kimi-latest',
      }),
      overrides: {
        explore: {
          model: 'openai/gpt-5.5',
        },
      },
    });
    expect(resolved.model).toBe('openai/gpt-5.5');
  });

  test('config override beats skill model when skill says inherit', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'explore',
        agentModel: 'inherit',
      }),
      overrides: {
        explore: {
          model: 'openai/gpt-5.5',
        },
      },
    });
    expect(resolved.model).toBe('openai/gpt-5.5');
  });
});

describe('resolveAgent — instructions override', () => {
  test('no override → uses skill body verbatim', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'explore',
        instructions: 'SKILL BODY',
      }),
    });
    expect(resolved.instructions).toBe('SKILL BODY');
  });

  test('override.instructions in default mode → appends after skill body', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'explore',
        instructions: 'SKILL BODY',
      }),
      overrides: {
        explore: {
          instructions: 'EXTRA',
        },
      },
    });
    expect(resolved.instructions).toBe('SKILL BODY\n\nEXTRA');
  });

  test('override.instructions with mode="replace" → replaces skill body', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'explore',
        instructions: 'SKILL BODY',
      }),
      overrides: {
        explore: {
          instructions: 'REPLACEMENT',
          instructionsMode: 'replace',
        },
      },
    });
    expect(resolved.instructions).toBe('REPLACEMENT');
  });
});

describe('resolveAgent — tools override', () => {
  test('no override → falls back to skill allowed-tools', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'explore',
        allowedTools: [
          'read',
          'grep',
        ],
      }),
    });
    expect(resolved.tools.map((t) => t.name).sort()).toEqual([
      'grep',
      'read',
    ]);
  });

  test('override.tools fully replaces skill allow-list', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'explore',
        allowedTools: [
          'read',
          'grep',
        ],
      }),
      overrides: {
        explore: {
          tools: [
            'bash',
          ],
        },
      },
    });
    expect(resolved.tools.map((t) => t.name)).toEqual([
      'bash',
    ]);
  });

  test('override.tools = [] yields empty toolset', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'explore',
        allowedTools: [
          'read',
          'grep',
        ],
      }),
      overrides: {
        explore: {
          tools: [],
        },
      },
    });
    expect(resolved.tools).toEqual([]);
  });

  test('skill with no allow-list and no override → inherits full parent pool', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'explore',
      }),
    });
    expect(resolved.tools.map((t) => t.name).sort()).toEqual([
      'bash',
      'grep',
      'read',
      'write',
    ]);
  });
});

describe('resolveAgent — background flag', () => {
  test('default (no input flag, no skill flag) → not background', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'explore',
      }),
    });
    expect(resolved.background).toBe(false);
  });

  test('input.run_in_background=true → background', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'explore',
      }),
      runInBackground: true,
    });
    expect(resolved.background).toBe(true);
  });

  test('skill.agentBackground=true → background', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'verification',
        agentBackground: true,
      }),
    });
    expect(resolved.background).toBe(true);
  });

  test('input.run_in_background=false + skill.agentBackground=true → still background (skill wins)', () => {
    const resolved = runResolve({
      skill: makeSkill({
        agentType: 'verification',
        agentBackground: true,
      }),
      runInBackground: false,
    });
    expect(resolved.background).toBe(true);
  });
});
