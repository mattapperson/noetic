import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { TEAMMATE_NAME_PATTERN } from '../src/tools/agent.js';

// Imports the regex directly from the runtime so future edits to the pattern
// must be paired with intentional updates to these cases.
const NameSchema = z.string().regex(TEAMMATE_NAME_PATTERN).optional();

describe('agent tool — name input regex', () => {
  test.each([
    [
      'researcher',
      true,
    ],
    [
      'agent_1',
      true,
    ],
    [
      'A-name',
      true,
    ],
    [
      'a',
      true,
    ],
  ])('accepts valid name: %p', (input, _ok) => {
    const r = NameSchema.safeParse(input);
    expect(r.success).toBe(true);
  });

  test.each([
    [
      '',
      'empty string',
    ],
    [
      '1leadingDigit',
      'starts with digit',
    ],
    [
      '-leadingDash',
      'starts with dash',
    ],
    [
      '_leadingUnder',
      'starts with underscore',
    ],
    [
      'has space',
      'space',
    ],
    [
      'has.dot',
      'dot',
    ],
    [
      'has/slash',
      'slash',
    ],
    [
      'has;semi',
      'semicolon',
    ],
    [
      '$(rm -rf /)',
      'shell substitution',
    ],
    [
      '`whoami`',
      'backtick',
    ],
    [
      '../../etc',
      'path traversal',
    ],
    [
      '\nmultiline',
      'newline',
    ],
    [
      'a'.repeat(64),
      'too long (>63)',
    ],
  ])('rejects invalid name %p (%s)', (input, _label) => {
    const r = NameSchema.safeParse(input);
    expect(r.success).toBe(false);
  });
});
