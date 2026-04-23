import { describe, expect, test } from 'bun:test';
import { BUILT_IN_SKILLS } from '../src/skills/built-in/index.js';
import { getAgent, listAgents } from '../src/skills/catalog.js';
import type { SkillDefinition } from '../src/skills/types.js';
import { SkillSource } from '../src/skills/types.js';

function makeSkill(name: string, agentType: string | undefined): SkillDefinition {
  return {
    name,
    description: `${name} desc`,
    instructions: `body of ${name}`,
    source: SkillSource.BuiltIn,
    filePath: null,
    userInvocable: true,
    modelInvocable: true,
    agentType,
  };
}

describe('catalog.listAgents', () => {
  test('returns only skills with agentType set', () => {
    const catalog: SkillDefinition[] = [
      makeSkill('plain-skill', undefined),
      makeSkill('foo-agent', 'foo'),
      makeSkill('bar-agent', 'bar'),
    ];
    const agents = listAgents(catalog);
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.agentType).sort()).toEqual([
      'bar',
      'foo',
    ]);
  });

  test('returns empty array when no skills declare agentType', () => {
    const catalog = [
      makeSkill('skill-a', undefined),
      makeSkill('skill-b', undefined),
    ];
    expect(listAgents(catalog)).toEqual([]);
  });
});

describe('catalog.getAgent', () => {
  test('finds a skill by agentType', () => {
    const target = makeSkill('explore-agent', 'explore');
    const catalog = [
      makeSkill('plain', undefined),
      target,
      makeSkill('plan-agent', 'plan'),
    ];
    expect(getAgent(catalog, 'explore')).toBe(target);
  });

  test('returns undefined for unknown agentType', () => {
    const catalog = [
      makeSkill('foo-agent', 'foo'),
    ];
    expect(getAgent(catalog, 'bar')).toBeUndefined();
  });

  test('last-wins on duplicate agentType (mirrors buildSkillCatalog precedence)', () => {
    const first = makeSkill('a', 'dup');
    const second = makeSkill('b', 'dup');
    const catalog = [
      first,
      second,
    ];
    expect(getAgent(catalog, 'dup')).toBe(second);
  });
});

describe('built-in agent skills', () => {
  test('ship general-purpose, explore, and plan as agents', () => {
    const builtInAgents = listAgents(BUILT_IN_SKILLS);
    const types = builtInAgents.map((a) => a.agentType).sort();
    expect(types).toEqual([
      'explore',
      'general-purpose',
      'plan',
    ]);
  });

  test('explore agent restricts tools to read-only set', () => {
    const explore = getAgent(BUILT_IN_SKILLS, 'explore');
    expect(explore).toBeDefined();
    if (!explore) {
      return;
    }
    expect(explore.allowedTools).toEqual([
      'read',
      'grep',
      'find',
      'ls',
    ]);
    expect(explore.agentOmitClaudeMd).toBe(true);
  });

  test('plan agent restricts tools to read-only set', () => {
    const plan = getAgent(BUILT_IN_SKILLS, 'plan');
    expect(plan).toBeDefined();
    if (!plan) {
      return;
    }
    expect(plan.allowedTools).toEqual([
      'read',
      'grep',
      'find',
      'ls',
    ]);
  });

  test('general-purpose agent does not restrict tools (inherits parent)', () => {
    const gp = getAgent(BUILT_IN_SKILLS, 'general-purpose');
    expect(gp).toBeDefined();
    if (!gp) {
      return;
    }
    expect(gp.allowedTools).toBeUndefined();
  });
});
