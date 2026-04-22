/**
 * Agent configuration types.
 */

import type { FsAdapter } from '@noetic/core';
import { z } from 'zod';

/**
 * A plugin reference in a config file. Either:
 * - a string (module path or package name),
 * - a `{ name, path?, options? }` spec resolved by the loader, or
 * - an already-instantiated `NoeticPlugin` object (detected by `name` +
 *   `version` + at least one plugin hook; the loader does the strict check).
 *
 * The inline branch uses `passthrough()` so function fields survive parsing —
 * zod would otherwise strip them from a plain `z.object({...})`.
 */
export const PluginSpecSchema = z.union([
  z.string(),
  z
    .object({
      name: z.string(),
      version: z.string(),
    })
    .passthrough(),
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
  /**
   * How `systemPrompt` combines with the built-in Claude-Code-parity prompt.
   * - `'compose'` (default): `systemPrompt` replaces the intro section only;
   *   cyber-risk, doing-tasks, tone/style, and env-info sections are still appended.
   * - `'replace'`: `systemPrompt` fully replaces the built-in prompt.
   * Ignored when `systemPrompt` is unset.
   */
  systemPromptMode: z
    .enum([
      'replace',
      'compose',
    ])
    .optional(),
  /**
   * If `true`, project-origin AGENT.md / rules files execute `!command` lines at session start.
   * Default `false` for supply-chain safety. User-origin files (`~/...`) always execute commands.
   */
  trustProjectEmbeddedCommands: z.boolean().optional(),
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
