/**
 * Documenting the contract: `ChordSafeTextInput` drops Ctrl+<single char>
 * chords on the floor instead of writing the bare letter to the buffer the
 * way `ink-text-input` does. Full keyboard-driven integration tests live
 * in the e2e suite — this file pins the behavioural contract that the
 * component must continue to honour.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('ChordSafeTextInput', () => {
  test('source explicitly bails on any Ctrl-modified key', () => {
    // The upstream ink-text-input filter list (arrows + Tab + Ctrl+C) is
    // unsafe: every other Ctrl+<letter> chord falls through and writes a
    // bare letter to the buffer. The whole reason this component exists is
    // a broader bail. Pin that explicit `key.ctrl` early-return in the
    // source so a future "simplification" can't quietly regress it.
    const source = readFileSync(
      join(__dirname, '../src/tui/components/chord-safe-text-input.tsx'),
      'utf8',
    );
    expect(source).toContain('if (key.ctrl)');
    // And confirm we're not delegating to ink-text-input under the hood —
    // any future refactor that re-introduces the upstream import would
    // silently bring back the bug.
    expect(source).not.toMatch(/from\s+['"]ink-text-input['"]/);
  });
});
