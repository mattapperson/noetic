/**
 * Agent configuration types.
 */

import type { FsAdapter } from '@noetic/core';
import { z } from 'zod';

export const PluginSpecSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    path: z.string().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export const AgentConfigSchema = z.object({
  model: z.string(),
  cwd: z.string(),
  apiKey: z.string().min(1),
  maxTurns: z.number().int().positive(),
  systemPrompt: z.string().optional(),
  plugins: z.array(PluginSpecSchema).optional(),
  tools: z
    .object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  memory: z.array(z.string()).optional(),
});

export type PluginSpec = z.infer<typeof PluginSpecSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/** Runtime-only config that extends the serializable AgentConfig with non-serializable fields. */
export interface AgentRuntimeConfig extends AgentConfig {
  fs: FsAdapter;
}
