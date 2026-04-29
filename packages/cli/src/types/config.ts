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

/**
 * Hook-command shape: a single command string or a named table of commands.
 * Mirrors worktrunk's hook value format (https://worktrunk.dev/config/).
 */
export const WorktreeHookSchema = z.union([
  z.string(),
  z.record(z.string(), z.string()),
]);

/**
 * `worktree` namespace: subset of worktrunk's config schema applied when the
 * `agent` tool is invoked with `isolation: 'worktree'`. noetic interprets these
 * directly — no `wt` binary dependency.
 *
 * Template variables available in `worktree-path`, `branch`, and hook commands:
 *   `{{ repo }}`, `{{ repo_path }}`, `{{ branch }}`, `{{ worktree_path }}`,
 *   `{{ worktree_name }}`, `{{ default_branch }}`, `{{ agent_id }}`.
 * Filters: `sanitize` (replace `/` and `\` with `-`), `hash_port` (deterministic
 * 10000–19999), matching worktrunk's behavior.
 */
export const WorktreeConfigSchema = z.object({
  'worktree-path': z.string().optional(),
  branch: z.string().optional(),
  'pre-start': WorktreeHookSchema.optional(),
  'post-start': WorktreeHookSchema.optional(),
  'post-merge': WorktreeHookSchema.optional(),
  'pre-remove': WorktreeHookSchema.optional(),
  'clone-files': z.array(z.string()).optional(),
  cleanup: z
    .enum([
      'always',
      'if-clean',
      'never',
    ])
    .optional(),
});

export type WorktreeHook = z.infer<typeof WorktreeHookSchema>;
export type WorktreeConfig = z.infer<typeof WorktreeConfigSchema>;

/**
 * Per-CLI UI tuning. Currently exposes only the double-press window for
 * Ctrl+C / Ctrl+D exit confirmation; new knobs land here as they ship.
 */
export const UiConfigSchema = z.object({
  /**
   * Milliseconds within which a second Ctrl+C / Ctrl+D press triggers a
   * graceful exit instead of just re-arming the hint. Default 800 (matches
   * Claude Code). Range chosen to keep the prompt feeling snappy without
   * making the second press easy to fat-finger.
   */
  doublePressWindowMs: z.number().int().min(100).max(5000).optional(),
});

export type UiConfig = z.infer<typeof UiConfigSchema>;

/**
 * History-window namespace: caps the number of trailing items projected to
 * the LLM on every turn. Storage (`itemLog`, session JSON) is untouched —
 * the cap is a read-side projection only. When `maxItems` is unset, the
 * `historyWindow` layer is not installed and history is uncapped (the
 * pre-existing default behaviour).
 */
export const HistoryConfigSchema = z.object({
  /** Cap on trailing items sent to the LLM. The minimum-exchange guarantee
   *  may exceed this temporarily to preserve at least one user/assistant pair. */
  maxItems: z.number().int().min(2).max(1e4).optional(),
});

export type HistoryConfig = z.infer<typeof HistoryConfigSchema>;

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
  worktree: WorktreeConfigSchema.optional(),
  ui: UiConfigSchema.optional(),
  history: HistoryConfigSchema.optional(),
});

export type PluginSpec = z.infer<typeof PluginSpecSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/** Runtime-only config that extends the serializable AgentConfig with non-serializable fields. */
export interface AgentRuntimeConfig extends AgentConfig {
  fs: FsAdapter;
}

/**
 * CLI-only flags carried alongside the serializable `AgentConfig`.
 * Kept off `AgentConfigSchema` because these describe runtime dispatch
 * (which session to resume, whether to persist) rather than agent shape.
 */
export interface CliFlags {
  /** `-c / --continue`: load the most recent session for the current cwd. */
  continueLatest: boolean;
  /**
   * `-r / --resume`: `true` opens the picker, a string is treated as a
   * session id (UUID), `false` means the flag was not passed.
   */
  resume: boolean | string;
  /** `--fork-session`: on resume, generate a fresh sessionId for the loaded history. */
  forkSession: boolean;
  /** `--session-id <uuid>`: force a specific session id (validated upstream). */
  sessionId?: string;
  /**
   * `true` when the user passed `--model` on the command line. Lets callers
   * distinguish "user explicitly chose a model" from "args parser filled in
   * the default" so a config-file model (or a resumed session's model) can
   * still take precedence.
   */
  modelExplicit: boolean;
  /** `-n / --name <name>`: set `customTitle` on the session. */
  name?: string;
  /** `--no-session-persistence`: skip disk writes for this run. */
  noSessionPersistence: boolean;
}

export const DEFAULT_CLI_FLAGS: CliFlags = {
  continueLatest: false,
  resume: false,
  forkSession: false,
  modelExplicit: false,
  noSessionPersistence: false,
};
