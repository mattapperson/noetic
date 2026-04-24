/**
 * Tests for content type detection (JSON / Markdown / plain text)
 */

import { describe, expect, it } from 'bun:test';
import { detectContentType } from '../src/client/lib/content-detect';

describe('detectContentType', () => {
  describe('json detection', () => {
    it('returns json for a valid JSON object', () => {
      expect(detectContentType('{"key": "value"}')).toBe('json');
    });

    it('returns json for a valid JSON array', () => {
      expect(detectContentType('[1, 2, 3]')).toBe('json');
    });

    it('returns json for a nested JSON object', () => {
      expect(detectContentType('{"a": {"b": [1, 2]}}')).toBe('json');
    });

    it('returns json for an empty JSON object', () => {
      expect(detectContentType('{}')).toBe('json');
    });

    it('returns json for an empty JSON array', () => {
      expect(detectContentType('[]')).toBe('json');
    });

    it('returns json over markdown when the string is valid JSON even with markdown-like content', () => {
      const jsonWithMd = JSON.stringify({
        heading: '# Title',
        bold: '**important**',
        list: '- item',
      });
      expect(detectContentType(jsonWithMd)).toBe('json');
    });

    it('returns json when leading/trailing whitespace surrounds valid JSON', () => {
      expect(detectContentType('  {"x": 1}  ')).toBe('json');
    });
  });

  describe('markdown detection', () => {
    it('returns markdown for headings combined with bold', () => {
      expect(detectContentType('# Title\n\nSome **bold** text')).toBe('markdown');
    });

    it('returns markdown for unordered list combined with links', () => {
      expect(detectContentType('- item one\n- [link](http://example.com)')).toBe('markdown');
    });

    it('returns markdown for code fences combined with inline code', () => {
      expect(detectContentType('```js\ncode\n```\nUse `foo` here')).toBe('markdown');
    });

    it('returns markdown for ordered list combined with blockquote', () => {
      expect(detectContentType('1. First\n> a quote')).toBe('markdown');
    });

    it('returns markdown for LaTeX inline math combined with bold', () => {
      expect(detectContentType('The value \\( x \\) is **important**')).toBe('markdown');
    });

    it('returns markdown for LaTeX display math combined with heading', () => {
      expect(detectContentType('# Math\n\\[x + y\\]')).toBe('markdown');
    });

    it('returns markdown for dollar-sign inline math combined with another indicator', () => {
      expect(detectContentType('The cost is $100$ and **note**')).toBe('markdown');
    });

    it('returns markdown for display math $$ combined with list', () => {
      expect(detectContentType('$$E = mc^2$$\n- physics')).toBe('markdown');
    });

    it('returns markdown for italic combined with links', () => {
      expect(detectContentType('This is *italic* and [a link](url)')).toBe('markdown');
    });
  });

  describe('text detection', () => {
    it('returns text for plain strings with no markdown', () => {
      expect(detectContentType('hello world')).toBe('text');
    });

    it('returns text for empty strings', () => {
      expect(detectContentType('')).toBe('text');
    });

    it('returns text for strings with only whitespace and newlines', () => {
      expect(detectContentType('   \n\n  \t  ')).toBe('text');
    });

    it('returns text when only one markdown indicator matches (heading only)', () => {
      expect(detectContentType('# Just a heading')).toBe('text');
    });

    it('returns text when only one markdown indicator matches (bold only)', () => {
      expect(detectContentType('Some **bold** here')).toBe('text');
    });

    it('returns text for invalid JSON that looks like it might be JSON', () => {
      expect(detectContentType('{not valid json}')).toBe('text');
    });

    it('returns text for a string that starts/ends with brackets but is not valid JSON', () => {
      expect(detectContentType('[not, valid, json]')).toBe('text');
    });
  });
});
