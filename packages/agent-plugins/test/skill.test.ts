/**
 * The `SKILL.md` format, per the Agent Skills specification that Agent Plugins
 * §7.1 delegates to.
 */

import { describe, expect, test } from 'bun:test';
import { parseAllowedTools, parseSkill } from '../src/skill';

function doc(frontmatter: string, body = 'Body text.'): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

describe('frontmatter block', () => {
  test('parses a minimal skill', () => {
    const result = parseSkill(
      doc('name: deploy\ndescription: Deploys things. Use when deploying.'),
      'deploy',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.skill.frontmatter.name).toBe('deploy');
    expect(result.skill.body).toBe('Body text.');
  });

  test('rejects a file with no frontmatter', () => {
    const result = parseSkill('# Just markdown\n', 'deploy');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.detail).toContain('frontmatter');
  });

  test('rejects an unterminated frontmatter block', () => {
    expect(parseSkill('---\nname: deploy\n', 'deploy').ok).toBe(false);
  });

  test('does not treat a horizontal rule in the body as frontmatter', () => {
    // The opening delimiter is anchored to position zero, so a `---` further
    // down is body content.
    const result = parseSkill('# Title\n\n---\n\nMore text\n', 'deploy');
    expect(result.ok).toBe(false);
  });

  test('tolerates CRLF line endings and a UTF-8 BOM', () => {
    const source = '﻿---\r\nname: deploy\r\ndescription: Deploys things.\r\n---\r\nBody.\r\n';
    const result = parseSkill(source, 'deploy');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.skill.body).toBe('Body.\n');
  });

  test('accepts an empty body', () => {
    const result = parseSkill('---\nname: deploy\ndescription: Deploys.\n---', 'deploy');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.skill.body).toBe('');
  });

  test('rejects frontmatter that is not valid YAML', () => {
    const result = parseSkill(doc('name: [unclosed'), 'deploy');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.detail).toContain('YAML');
  });

  test('rejects frontmatter that is not a mapping', () => {
    expect(parseSkill(doc('- a\n- b'), 'deploy').ok).toBe(false);
  });
});

describe('name field', () => {
  test('requires the name to match the directory', () => {
    const result = parseSkill(doc('name: deploy\ndescription: Deploys.'), 'release');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.detail).toContain('directory');
  });

  const invalid = [
    [
      'PDF-Processing',
      'uppercase',
    ],
    [
      '-pdf',
      'leading hyphen',
    ],
    [
      'pdf-',
      'trailing hyphen',
    ],
    [
      'pdf--processing',
      'consecutive hyphens',
    ],
    [
      'pdf.processing',
      'period not allowed in a skill name',
    ],
    [
      'pdf_processing',
      'underscore',
    ],
  ];
  for (const entry of invalid) {
    const name = entry[0] ?? '';
    test(`rejects '${name}' (${entry[1]})`, () => {
      expect(parseSkill(doc(`name: ${name}\ndescription: X.`), name).ok).toBe(false);
    });
  }

  test('accepts 64 characters and rejects 65', () => {
    const ok = 'a'.repeat(64);
    const tooLong = 'a'.repeat(65);
    expect(parseSkill(doc(`name: ${ok}\ndescription: X.`), ok).ok).toBe(true);
    expect(parseSkill(doc(`name: ${tooLong}\ndescription: X.`), tooLong).ok).toBe(false);
  });
});

describe('description field', () => {
  test('is required', () => {
    expect(parseSkill(doc('name: deploy'), 'deploy').ok).toBe(false);
  });

  test('rejects an empty description', () => {
    expect(parseSkill(doc("name: deploy\ndescription: ''"), 'deploy').ok).toBe(false);
  });

  test('accepts 1024 characters and rejects 1025', () => {
    const ok = 'a'.repeat(1024);
    const tooLong = 'a'.repeat(1025);
    expect(parseSkill(doc(`name: deploy\ndescription: ${ok}`), 'deploy').ok).toBe(true);
    expect(parseSkill(doc(`name: deploy\ndescription: ${tooLong}`), 'deploy').ok).toBe(false);
  });
});

describe('optional fields', () => {
  test('accepts license, compatibility, metadata, and allowed-tools', () => {
    const result = parseSkill(
      doc(
        [
          'name: pdf-processing',
          'description: Extract PDF text. Use when handling PDFs.',
          'license: Apache-2.0',
          'compatibility: Requires Python 3.14+ and uv',
          'metadata:',
          '  author: example-org',
          "  version: '1.0'",
          'allowed-tools: Bash(git:*) Bash(jq:*) Read',
        ].join('\n'),
      ),
      'pdf-processing',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { frontmatter } = result.skill;
    expect(frontmatter.license).toBe('Apache-2.0');
    expect(frontmatter.metadata).toEqual({
      author: 'example-org',
      version: '1.0',
    });
    expect(frontmatter['allowed-tools']).toBe('Bash(git:*) Bash(jq:*) Read');
  });

  test('rejects a compatibility over 500 characters', () => {
    const tooLong = 'a'.repeat(501);
    expect(
      parseSkill(doc(`name: deploy\ndescription: X.\ncompatibility: ${tooLong}`), 'deploy').ok,
    ).toBe(false);
  });

  test('rejects a non-string metadata value', () => {
    expect(
      parseSkill(doc('name: deploy\ndescription: X.\nmetadata:\n  count: 3'), 'deploy').ok,
    ).toBe(false);
  });

  test('rejects an unrecognized frontmatter field', () => {
    // A typo like `descripton` would otherwise load a skill the model can
    // never select, since it has no description to match against.
    const result = parseSkill(doc('name: deploy\ndescription: X.\ndescripton: typo'), 'deploy');
    expect(result.ok).toBe(false);
  });
});

describe('parseAllowedTools', () => {
  test('splits on whitespace', () => {
    expect(parseAllowedTools('Bash(git:*)  Read\tWrite')).toEqual([
      'Bash(git:*)',
      'Read',
      'Write',
    ]);
  });

  test('returns an empty list for an absent or blank field', () => {
    expect(parseAllowedTools(undefined)).toEqual([]);
    expect(parseAllowedTools('   ')).toEqual([]);
  });
});
