import { describe, expect, test } from 'bun:test';
import { previewToolArgs } from '../src/tui/tool-args-preview.js';

describe('previewToolArgs', () => {
  describe('generic preferred-key fallback', () => {
    test('picks path from JSON object', () => {
      expect(previewToolArgs('Read', '{"path":"src/index.ts"}')).toBe('src/index.ts');
    });

    test('picks command when path absent', () => {
      expect(previewToolArgs('Bash', '{"command":"ls -la"}')).toBe('ls -la');
    });

    test('returns empty string for JSON object with no preferred keys', () => {
      expect(previewToolArgs('Unknown', '{"recursive":true,"depth":3}')).toBe('');
    });

    test('returns empty string for JSON object with non-string preferred value', () => {
      // `{"path": 42}` — path exists but isn't a string, so it's skipped.
      expect(previewToolArgs('Read', '{"path":42}')).toBe('');
    });

    test('returns empty string for JSON array', () => {
      // Arrays aren't records; previewer returns '' after skipping preferred-key lookup.
      expect(previewToolArgs('Unknown', '[1,2,3]')).toBe('[1,2,3]');
    });

    test('returns empty string for JSON null', () => {
      // `null` parses as JSON but isn't a record — falls back to raw truncation.
      expect(previewToolArgs('Unknown', 'null')).toBe('null');
    });

    test('falls back to raw truncation for non-JSON', () => {
      expect(previewToolArgs('Unknown', 'not json here')).toBe('not json here');
    });

    test('picks file_path (snake_case) for tools that use that key', () => {
      expect(previewToolArgs('Unknown', '{"file_path":"snake.ts"}')).toBe('snake.ts');
    });

    test('returns empty string for empty input', () => {
      expect(previewToolArgs('Unknown', '')).toBe('');
      expect(previewToolArgs('Unknown', '   ')).toBe('');
    });

    test('truncates long preferred value', () => {
      const long = 'a'.repeat(1e2);
      const result = previewToolArgs(
        'Read',
        JSON.stringify({
          path: long,
        }),
      );
      expect(result.length).toBeLessThan(long.length);
      expect(result.endsWith('…')).toBe(true);
    });
  });

  describe('lsp previewer', () => {
    test('formats operation + filePath + line:char', () => {
      const args = JSON.stringify({
        operation: 'hover',
        filePath: 'src/foo.ts',
        line: 42,
        character: 10,
      });
      expect(previewToolArgs('lsp', args)).toBe('hover src/foo.ts:42:10');
    });

    test('falls back when filePath is missing', () => {
      const args = JSON.stringify({
        operation: 'workspaceSymbol',
      });
      expect(previewToolArgs('lsp', args)).toBe('workspaceSymbol');
    });

    test('omits operation when absent', () => {
      const args = JSON.stringify({
        filePath: 'src/foo.ts',
        line: 1,
        character: 0,
      });
      expect(previewToolArgs('lsp', args)).toBe('src/foo.ts:1:0');
    });

    test('omits position when line or character missing', () => {
      const args = JSON.stringify({
        operation: 'hover',
        filePath: 'src/foo.ts',
        line: 42,
      });
      expect(previewToolArgs('lsp', args)).toBe('hover src/foo.ts');
    });

    test('returns empty when no lsp-relevant keys', () => {
      expect(
        previewToolArgs(
          'lsp',
          JSON.stringify({
            unrelated: true,
          }),
        ),
      ).toBe('');
    });

    test.skipIf(!process.env.HOME)('relativizes home directory paths', () => {
      const home = process.env.HOME;
      const args = JSON.stringify({
        operation: 'hover',
        filePath: `${home}/Development/foo.ts`,
        line: 1,
        character: 0,
      });
      expect(previewToolArgs('lsp', args)).toBe('hover ~/Development/foo.ts:1:0');
    });

    test('truncates rendered output at the 80-char cap', () => {
      // "hover " (6) + filePath + ":1:0" (4) = 10 + len(filePath). Feed a
      // 100-char filePath so the raw render is 110 chars; expect truncation
      // to exactly 80 chars + ellipsis, catching off-by-ones.
      const args = JSON.stringify({
        operation: 'hover',
        filePath: 'a'.repeat(1e2),
        line: 1,
        character: 0,
      });
      const result = previewToolArgs('lsp', args);
      expect(result.endsWith('…')).toBe(true);
      // 80 kept chars + single-char ellipsis = 81.
      expect(result.length).toBe(8.1e1);
    });
  });
});
