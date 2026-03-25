/**
 * Agent configuration types.
 */

import { z } from 'zod';

export const AgentConfigSchema = z.object({
  model: z.string(),
  cwd: z.string(),
  apiKey: z.string().min(1),
  maxTurns: z.number().int().positive(),
  systemPrompt: z.string().optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
