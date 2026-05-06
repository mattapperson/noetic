/**
 * Session file schema — v1. `items` is the LLM source of truth; `entries`
 * is a redundant TUI view persisted for faster render on resume.
 */

import type { Item, LastLayerUsage, StreamingItem } from '@noetic/core';
import { ItemSchema } from '@noetic/core';
import { z } from 'zod';

//#region Entry Types

export interface UserEntry {
  role: 'user';
  content: string;
  /** Stable id assigned when the entry is created. Used to flip `deliveryStatus`
   *  from `queued` to `sent` once the message is delivered to the agent. */
  id?: string;
  /** `queued` when the message was enqueued while the session was generating;
   *  `sent` once the session has started a turn that includes it. Undefined
   *  defaults to `sent` in the UI (i.e. messages sent while idle). */
  deliveryStatus?: 'queued' | 'sent';
}

export interface ErrorEntry {
  role: 'system';
  type: 'error';
  content: string;
}

export interface SystemEntry {
  role: 'system';
  type: 'info';
  content: string;
}

export type AssistantEntry = Item | StreamingItem;
export type ConversationEntry = AssistantEntry | UserEntry | ErrorEntry | SystemEntry;

//#endregion

//#region Entry Schemas

const UserEntrySchema = z.object({
  role: z.literal('user'),
  content: z.string(),
  id: z.string().optional(),
  deliveryStatus: z
    .enum([
      'queued',
      'sent',
    ])
    .optional(),
});

const SystemEntrySchema = z.object({
  role: z.literal('system'),
  type: z.literal('info'),
  content: z.string(),
});

const ErrorEntrySchema = z.object({
  role: z.literal('system'),
  type: z.literal('error'),
  content: z.string(),
});

/** Runtime schema for {@link ConversationEntry}. Trust-boundary validation for
 *  persisted session entries. The assistant branch delegates to ItemSchema,
 *  which only structurally validates the `type` discriminant — provider-shaped
 *  items aren't deeply re-validated. */
export const ConversationEntrySchema: z.ZodType<ConversationEntry> = z.union([
  UserEntrySchema,
  SystemEntrySchema,
  ErrorEntrySchema,
  ItemSchema,
]);

//#endregion

//#region Entry Type Guards

export function isUserEntry(entry: ConversationEntry): entry is UserEntry {
  return 'role' in entry && entry.role === 'user';
}

export function isErrorEntry(entry: ConversationEntry): entry is ErrorEntry {
  return 'role' in entry && entry.role === 'system' && 'type' in entry && entry.type === 'error';
}

export function isSystemEntry(entry: ConversationEntry): entry is SystemEntry {
  return 'role' in entry && entry.role === 'system' && 'type' in entry && entry.type === 'info';
}

//#endregion

//#region Session File

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

//#endregion
