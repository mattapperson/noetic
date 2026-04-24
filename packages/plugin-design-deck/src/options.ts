/**
 * Plugin option schema. Parsed once when the plugin factory is called from the
 * user's `noetic.config.ts`.
 */

import { z } from 'zod';

export const DesignDeckOptionsSchema = z.object({
  /** How many options to request per `G` generate-more press. */
  generateCount: z.number().int().positive().max(12).default(3),
  /** Maximum total options per slide; generate-more caps here. */
  maxOptionsPerSlide: z.number().int().positive().max(20).default(9),
  /** Write a snapshot even when the user cancels the deck. */
  autoSaveOnCancel: z.boolean().default(true),
  /** Write a snapshot when the user submits. */
  autoSaveOnSubmit: z.boolean().default(true),
  /** Override the model used for in-modal generation (defaults to agent's model). */
  generateModel: z.string().optional(),
});

export type DesignDeckOptions = z.infer<typeof DesignDeckOptionsSchema>;
export type DesignDeckInput = z.input<typeof DesignDeckOptionsSchema>;

export const DesignDeckInputSchema = DesignDeckOptionsSchema.partial().default(() => ({}));
