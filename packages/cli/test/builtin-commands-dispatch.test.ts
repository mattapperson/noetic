/**
 * Regression: the TUI command dispatch must surface every builtin command,
 * including the JSX-rendering ones (`/context`, `/model`, `/config`,
 * `/diff-review`, `/skills`).
 *
 * Before PR #45 the dispatch barrel `src/tui/app-parts/commands.ts` re-exported
 * `BUILTIN_COMMANDS` from `src/commands/builtins/index.ts`, which only listed
 * the 10 non-presentation commands. The five JSX commands lived in a sibling
 * `src/tui/commands/index.ts` registry that the dispatch path never reached,
 * so typing any of them produced "Unknown command". This test guards against
 * that shadow-by-name reintroducing itself.
 */

import { describe, expect, test } from 'bun:test';
import { BUILTIN_COMMANDS } from '../src/tui/app-parts/commands.js';

const REQUIRED_PRESENTATION_COMMANDS = [
  'context',
  'model',
  'config',
  'diff-review',
  'skills',
] as const;

describe('TUI dispatch barrel (src/tui/app-parts/commands)', () => {
  test('exposes the five JSX presentation commands', () => {
    const names = new Set(BUILTIN_COMMANDS.map((c) => c.name));
    for (const required of REQUIRED_PRESENTATION_COMMANDS) {
      expect(names.has(required)).toBe(true);
    }
  });

  test('JSX presentation commands are typed as local-jsx (not stripped from dispatch)', () => {
    for (const required of REQUIRED_PRESENTATION_COMMANDS) {
      const cmd = BUILTIN_COMMANDS.find((c) => c.name === required);
      expect(cmd).toBeDefined();
      expect(cmd?.type).toBe('local-jsx');
    }
  });
});
