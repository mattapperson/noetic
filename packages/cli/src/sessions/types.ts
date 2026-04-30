/**
 * Session file schema — v1. `items` is the LLM source of truth; `entries`
 * is a redundant TUI view persisted for faster render on resume.
 */

import type { LastLayerUsage } from '@noetic/core';
import { ItemSchema } from '@noetic/core';
import { z } from 'zod';
import { ConversationEntrySchema } from '../tui/item-utils.js';

const CumulativeUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
});

const LayerUsageEntrySchema = z.object({
  layerId: z.string(),
  tokenCount: z.number().int().nonnegative(),
  items: z.array(ItemSchema),
});

/**
 * Persisted shape of `LastLayerUsage` from `@noetic/core`. The core type is
 * `readonly`, so we mirror it as a plain object schema and let Zod's inferred
 * output (mutable) be assignable anywhere the core `readonly` type is
 * expected (readonly is bivariant for indexed access).
 */
export const LastLayerUsageSchema = z.object({
  executionId: z.string(),
  modelId: z.string(),
  layers: z.array(LayerUsageEntrySchema),
  systemPromptTokens: z.number().int().nonnegative(),
  toolsTokens: z.number().int().nonnegative(),
  historyTokens: z.number().int().nonnegative(),
  totalUsedTokens: z.number().int().nonnegative(),
});

export const SessionFileV1Schema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
  cwd: z.string().min(1),
  effectiveCwd: z.string().min(1),
  model: z.string().min(1),
  agentMode: z.enum([
    'normal',
    'planning',
  ]),
  createdAt: z.string().datetime(),
  modifiedAt: z.string().datetime(),
  customTitle: z.string().optional(),
  tag: z.string().optional(),
  firstPrompt: z.string(),
  messageCount: z.number().int().nonnegative(),
  cumulativeUsage: CumulativeUsageSchema,
  cumulativeCost: z.number().nonnegative(),
  lastLayerUsage: LastLayerUsageSchema.optional(),
  items: z.array(ItemSchema),
  entries: z.array(ConversationEntrySchema),
});

// `lastLayerUsage` narrowed to the core readonly type (schema infers mutable).
export type SessionFile = Omit<z.infer<typeof SessionFileV1Schema>, 'lastLayerUsage'> & {
  lastLayerUsage?: LastLayerUsage;
};

export interface SessionMetadata {
  sessionId: string;
  cwd: string;
  model: string;
  createdAt: string;
  modifiedAt: string;
  customTitle?: string;
  tag?: string;
  firstPrompt: string;
  messageCount: number;
}

export function toSessionMetadata(file: SessionFile): SessionMetadata {
  return {
    sessionId: file.sessionId,
    cwd: file.cwd,
    model: file.model,
    createdAt: file.createdAt,
    modifiedAt: file.modifiedAt,
    customTitle: file.customTitle,
    tag: file.tag,
    firstPrompt: file.firstPrompt,
    messageCount: file.messageCount,
  };
}
