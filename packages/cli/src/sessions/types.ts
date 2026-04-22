/**
 * Session file schema — v1.
 *
 * Persisted at `~/.noetic/projects/{slug}/sessions/{sessionId}.json` as a
 * full snapshot overwritten each turn (see `./store.ts`). `items` is the LLM
 * source of truth; `entries` is a redundant TUI view persisted for faster
 * render on resume. On load, `entries` is trusted as-is except that queued
 * user messages are flipped to sent (see `normalizeEntriesForResume` in
 * `app.tsx`).
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

/**
 * Structural guard for the persisted `lastLayerUsage` field. The logical
 * shape is `@noetic/core#LastLayerUsage`, but historical files may carry
 * slightly different keys and the field is advisory (used only by the
 * footer). We require a plain (non-null, non-array) object so malformed
 * numeric/array/null payloads can't reach the UI through the loose
 * `isLastLayerUsageLike` guard in `app.tsx`, while still accepting any key
 * set for forward/backward compatibility. Typed as `LastLayerUsage` so the
 * inferred `SessionFile` shape matches what the rest of the CLI already
 * treats this field as.
 */
export const LastLayerUsageSchema = z.custom<LastLayerUsage>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  {
    message: 'lastLayerUsage must be a plain object',
  },
);

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
