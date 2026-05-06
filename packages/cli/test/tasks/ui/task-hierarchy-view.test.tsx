/**
 * Pure-helper coverage for `task-hierarchy-view.tsx`.
 *
 * The Ink rendering path is left to manual smoke tests; here we cover
 * `statusGlyph`, the only branchy helper, exhaustively.
 */

import { describe, expect, test } from 'bun:test';

import { statusGlyph } from '../../../src/tui/tasks/runtime-ui/task-hierarchy-view.js';

describe('statusGlyph', () => {
  test('active milestones/slices/features render the play glyph', () => {
    expect(statusGlyph('active')).toBe('▶');
  });

  test('completed milestones/slices and done features render the check glyph', () => {
    expect(statusGlyph('complete')).toBe('✓');
    expect(statusGlyph('done')).toBe('✓');
  });

  test('blocked entities render the cross glyph', () => {
    expect(statusGlyph('blocked')).toBe('✕');
  });

  test('triaged features render the asterisk glyph', () => {
    expect(statusGlyph('triaged')).toBe('*');
  });

  test('defined features render the bullet glyph', () => {
    expect(statusGlyph('defined')).toBe('·');
  });

  test('pending falls through to the ellipsis glyph', () => {
    expect(statusGlyph('pending')).toBe('…');
  });
});
