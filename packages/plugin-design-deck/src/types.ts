/**
 * Deck data model. Ink-focused subset of pi-design-deck's schema — no
 * mermaid/html/image preview blocks (no DOM in a terminal). Unknown block
 * types stay parseable so forward-compat decks from pi don't crash; the UI
 * renders a muted `[unsupported: {type}]` placeholder for them instead.
 */

import { z } from 'zod';

const KnownPreviewBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    body: z.string(),
  }),
  z.object({
    type: z.literal('code'),
    language: z.string().default('text'),
    source: z.string(),
  }),
  z.object({
    type: z.literal('markdown'),
    body: z.string(),
  }),
  z.object({
    type: z.literal('ascii'),
    body: z.string(),
  }),
]);

const UnsupportedPreviewBlockSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

export const PreviewBlockSchema = z.union([
  KnownPreviewBlockSchema,
  UnsupportedPreviewBlockSchema,
]);

export type KnownPreviewBlock = z.infer<typeof KnownPreviewBlockSchema>;
export type PreviewBlock = z.infer<typeof PreviewBlockSchema>;

export const OptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().default(''),
  aside: z.string().optional(),
  recommended: z.boolean().optional(),
  previewBlocks: z.array(PreviewBlockSchema).default([]),
});

export type DeckOption = z.infer<typeof OptionSchema>;

export const SlideSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  context: z.string().default(''),
  columns: z
    .union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
    ])
    .optional(),
  options: z.array(OptionSchema).min(1),
});

export type Slide = z.infer<typeof SlideSchema>;

export const DeckSchema = z.object({
  title: z.string().min(1),
  slides: z.array(SlideSchema).min(1),
});

export type Deck = z.infer<typeof DeckSchema>;

export interface DeckSelections {
  [slideId: string]: string;
}

/** Narrowing helper for the preview-block discriminated union. */
export function isKnownPreviewBlock(block: PreviewBlock): block is KnownPreviewBlock {
  return (
    block.type === 'text' ||
    block.type === 'code' ||
    block.type === 'markdown' ||
    block.type === 'ascii'
  );
}
