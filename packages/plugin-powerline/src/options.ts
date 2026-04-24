/**
 * Plugin option schema. Parsed once when the plugin factory is called from the
 * user's `noetic.config.ts`.
 */

import { z } from 'zod';

export const PresetNameSchema = z.enum([
  'default',
  'minimal',
  'compact',
  'full',
  'nerd',
  'ascii',
]);
export type PresetName = z.infer<typeof PresetNameSchema>;

export const NerdFontsModeSchema = z.enum([
  'auto',
  'on',
  'off',
]);
export type NerdFontsMode = z.infer<typeof NerdFontsModeSchema>;

export const VibeModeSchema = z.enum([
  'off',
  'file',
  'generate',
]);
export type VibeMode = z.infer<typeof VibeModeSchema>;

export const VibeOptionsSchema = z.object({
  theme: z.string().default('default'),
  mode: VibeModeSchema.default('file'),
  fallback: z.string().default('Working'),
  poolSize: z.number().int().positive().default(24),
});
export type VibeOptions = z.infer<typeof VibeOptionsSchema>;

export const PowerlineOptionsSchema = z.object({
  preset: PresetNameSchema.default('default'),
  segments: z.array(z.string()).optional(),
  theme: z.string().optional(),
  nerdFonts: NerdFontsModeSchema.default('auto'),
  vibe: VibeOptionsSchema.default(() => VibeOptionsSchema.parse({})),
});
export type PowerlineOptions = z.infer<typeof PowerlineOptionsSchema>;

export const PowerlineInputSchema = PowerlineOptionsSchema.partial().default(() => ({}));
export type PowerlineInput = z.input<typeof PowerlineInputSchema>;
