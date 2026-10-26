/**
 * Cloudflare Workers refuse code generation from strings (`eval`,
 * `new Function`, string timers), and core must run there. JSONata
 * interprets its own AST rather than compiling to JS, so it is safe today;
 * this test scans the file core actually loads so a version bump that starts
 * generating code fails here instead of in a deployed Worker.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CORE_SRC = join(import.meta.dir, '..', '..', 'src', 'expression');

const CODE_GENERATION = [
  {
    name: 'eval(',
    pattern: /(?<![\w$])eval\s*\(/,
  },
  {
    name: 'new Function',
    pattern: /new\s+Function\b/,
  },
  {
    name: 'Function(',
    pattern: /(?<![\w$])Function\s*\(/,
  },
  {
    name: 'string timer',
    pattern: /set(?:Timeout|Interval)\s*\(\s*['"`]/,
  },
  {
    name: 'dynamic import(',
    pattern: /(?<![\w$.])import\s*\(/,
  },
];

describe('jsonata on Cloudflare Workers', () => {
  const entry = Bun.resolveSync('jsonata', CORE_SRC);
  const manifest: {
    main?: string;
    module?: string;
  } = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8'));

  test('core loads the build this test scans', () => {
    expect(entry.endsWith(`${manifest.main}`)).toBe(true);
    expect(manifest.module).toBe(manifest.main);
  });

  test.each(CODE_GENERATION)('the build has no $name', ({ pattern }) => {
    const source = readFileSync(entry, 'utf8');
    const hit = source.split('\n').findIndex((line) => pattern.test(line));
    expect(hit === -1 ? 'none' : `${entry}:${hit + 1}`).toBe('none');
  });
});
