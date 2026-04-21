import { describe, expect, test } from 'bun:test';

import { DeckSchema, isKnownPreviewBlock, PreviewBlockSchema } from '../src/types.js';

describe('DeckSchema', () => {
  test('parses a minimal deck', () => {
    const result = DeckSchema.safeParse({
      title: 'x',
      slides: [
        {
          id: 's1',
          title: 't',
          options: [
            {
              label: 'a',
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.slides[0]?.options[0]?.description).toBe('');
      expect(result.data.slides[0]?.options[0]?.previewBlocks).toEqual([]);
    }
  });

  test('rejects empty slides array', () => {
    expect(
      DeckSchema.safeParse({
        title: 'x',
        slides: [],
      }).success,
    ).toBe(false);
  });

  test('rejects slide with zero options', () => {
    expect(
      DeckSchema.safeParse({
        title: 'x',
        slides: [
          {
            id: 's1',
            title: 't',
            options: [],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('PreviewBlockSchema', () => {
  test('parses text block', () => {
    const out = PreviewBlockSchema.parse({
      type: 'text',
      body: 'hi',
    });
    expect(out.type).toBe('text');
  });

  test('parses code block with default language', () => {
    const out = PreviewBlockSchema.parse({
      type: 'code',
      source: 'x=1',
    });
    if (out.type === 'code') {
      expect(out.language).toBe('text');
    }
  });

  test('tolerates unknown block types (forward-compat)', () => {
    const out = PreviewBlockSchema.parse({
      type: 'mermaid',
      source: 'graph TD;A-->B;',
    });
    expect(out.type).toBe('mermaid');
    expect(isKnownPreviewBlock(out)).toBe(false);
  });

  test('isKnownPreviewBlock narrows known types', () => {
    const block = PreviewBlockSchema.parse({
      type: 'ascii',
      body: 'X',
    });
    expect(isKnownPreviewBlock(block)).toBe(true);
  });
});
