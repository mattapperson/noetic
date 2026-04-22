/**
 * Session file schema — v1.
 *
 * Persisted at `~/.noetic/projects/{slug}/sessions/{sessionId}.json` as a
 * full snapshot overwritten each turn (see `./store.ts`). `items` is the LLM
 * source of truth; `entries` is the TUI view and is rebuilt from `items`
 * when the two disagree on load.
 */

import { ItemSchema } from '@noetic/core';
import { z } from 'zod';
import { ConversationEntrySchema } from '../tui/item-utils.js';

const CumulativeUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
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
  lastLayerUsage: z.unknown().optional(),
  items: z.array(ItemSchema),
  entries: z.array(ConversationEntrySchema),
});

export type SessionFile = z.infer<typeof SessionFileV1Schema>;

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
