/**
 * Agent configuration types.
 */

import type { FsAdapter } from '@noetic-tools/core';
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

/**
 * Shell namespace: knobs for how shell commands run.
 *
 * `useRtk` wraps every command that goes through the shell adapter with
 * `rtk rewrite` (https://github.com/rtk-ai/rtk) to filter and summarize
 * output before it reaches the model. When `true` (the default), `rtk` is a
 * hard requirement — startup fails fast with install instructions if it is
 * not on PATH. Set `false` to opt out; commands then run raw via `sh -c`.
 */
export const ShellConfigSchema = z.object({
  useRtk: z.boolean().default(true),
});

export type ShellConfig = z.infer<typeof ShellConfigSchema>;

/**
 * Setup namespace: persisted answers to the interactive startup binary check.
 *
 * `ignoredBinaries` lists binary ids the user has chosen to permanently skip
 * (e.g. `"rtk"`, `"pilotty"`, `"agent-browser"`). The CLI setup flow consults
 * this list before prompting; tools whose binary is ignored either run in a
 * degraded mode (rtk → raw shell) or are dropped from the agent's tool list
 * (pilotty → no interactive-terminal; agent-browser → no browser). This lives
 * in the user-global config (`~/.config/noetic/config.ts`) so the decision
 * persists across projects.
 */
export const SetupConfigSchema = z.object({
  ignoredBinaries: z.array(z.string()).default([]),
});

export type SetupConfig = z.infer<typeof SetupConfigSchema>;

/**
 * Per-sub-agent override applied when the parent agent invokes a teammate via
 * the `agent` tool. Keys in `agents` are agent-type ids (e.g. `explore`,
 * `plan`, `verification`) — they match the `agent-type` field on a SKILL.md.
 *
 * Each field overrides the matching SKILL.md frontmatter:
 *  - `model`        beats `agent-model` (including `inherit`)
 *  - `instructions` appended to the SKILL body, or replaces it when
 *                   `instructionsMode` is `'replace'`
 *  - `tools`        replaces the SKILL `allowed-tools` allowlist;
 *                   `[]` means "no tools"
 */
export const AgentOverrideSchema = z.object({
  model: z.string().optional(),
  instructions: z.string().optional(),
  instructionsMode: z
    .enum([
      'append',
      'replace',
    ])
    .optional(),
  tools: z.array(z.string()).optional(),
});

export type AgentOverride = z.infer<typeof AgentOverrideSchema>;

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
      /**
       * Default-on registration of the built-in `task_*` tools (see
       * `tasks/runtime/tools.ts`). Set `false` to opt out
       * entirely; otherwise the read/write subset is wired automatically
       * (read-only when the harness is in plan mode).
       */
      tasks: z.boolean().optional(),
    })
    .optional(),
  memory: z.array(z.string()).optional(),
  worktree: WorktreeConfigSchema.optional(),
  history: HistoryConfigSchema.optional(),
  shell: ShellConfigSchema.optional(),
  setup: SetupConfigSchema.optional(),
  /**
   * Per-sub-agent overrides keyed by `agent-type` (e.g. `explore`, `plan`,
   * `verification`). Beats the matching SKILL.md frontmatter. Surfaced via
   * host configuration UIs.
   */
  agents: z.record(z.string(), AgentOverrideSchema).optional(),
});

export type PluginSpec = z.infer<typeof PluginSpecSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/** Runtime-only config that extends the serializable AgentConfig with non-serializable fields. */
export interface AgentRuntimeConfig extends AgentConfig {
  fs: FsAdapter;
}
