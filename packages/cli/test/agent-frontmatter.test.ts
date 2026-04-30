import { describe, expect, test } from 'bun:test';
import { mapFrontmatterToAgentFields, parseFrontmatter } from '../src/skills/frontmatter.js';

describe('parseFrontmatter — agent fields', () => {
  test('accepts empty agent-* values (YAML null) without rejecting the whole skill', () => {
    const md = `---
name: my-skill
agent-type:
agent-model:
---
body
`;
    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter.name).toBe('my-skill');
    expect(body.trim()).toBe('body');
    expect(mapFrontmatterToAgentFields(frontmatter).agentType).toBeUndefined();
    expect(mapFrontmatterToAgentFields(frontmatter).agentModel).toBeUndefined();
  });

  test('rejects frontmatter when an agent field has a wrong primitive type', () => {
    const md = `---
name: bad-skill
agent-background: "not a boolean"
---
body
`;
    const { frontmatter } = parseFrontmatter(md);
    // Typeguard rejects → name is reset to empty so loaders fall back to dirName.
    expect(frontmatter.name).toBe('');
  });

  test('passes through valid agent fields', () => {
    const md = `---
name: ok
agent-type: explore
agent-model: haiku
agent-background: true
agent-max-steps: 12
agent-omit-claude-md: true
---
body
`;
    const { frontmatter } = parseFrontmatter(md);
    const fields = mapFrontmatterToAgentFields(frontmatter);
    expect(fields).toEqual({
      agentType: 'explore',
      agentModel: 'haiku',
      agentBackground: true,
      agentMaxSteps: 12,
      agentOmitClaudeMd: true,
    });
  });

  test('mapFrontmatterToAgentFields returns all-undefined when fields absent', () => {
    const md = `---
name: bare
---
`;
    const { frontmatter } = parseFrontmatter(md);
    const fields = mapFrontmatterToAgentFields(frontmatter);
    expect(fields).toEqual({
      agentType: undefined,
      agentModel: undefined,
      agentBackground: undefined,
      agentMaxSteps: undefined,
      agentOmitClaudeMd: undefined,
    });
  });
});
