/**
 * Reconcile flow — periodically syncs the on-disk task store with the live
 * `git worktree list`. Worktree-source tasks whose path no longer appears in
 * the porcelain output get atomically stamped `lifecycleStatus = 'removed'`.
 *
 * Composed as `every({ step: reconcileTickStep, ms: 60_000 })` so the daemon
 * orchestrator can drop it into a `fork({ mode: 'all', paths: [...] })`
 * alongside the autopilot, validator, and health flows. The whole tree is
 * driven by `harness.detachedSpawn(...)` from the daemon entry.
 */

import type { ReconcileTasksFsResult } from '@noetic/code-agent/tasks';
import { reconcileTasksFs } from '@noetic/code-agent/tasks';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import type { ProjectWorktree } from '@noetic/code-agent/tasks/worktree-node';
import { loadProjectWorktrees } from '@noetic/code-agent/tasks/worktree-node';
import type { ContextMemory, ShellAdapter, Step } from '@noetic/core';
import { every, step } from '@noetic/core';
import { createLocalShellAdapter } from '@noetic/platform-node';

//#region Types

/**
 * Resolves the live `git worktree list` for the given project root. The
 * production wiring uses {@link loadProjectWorktrees}; tests inject a stub
 * that returns a fixed list without spawning a real `git` subprocess.
 */
export type LoadWorktreesFn = (projectRoot: string) => Promise<ProjectWorktree[]>;

/** Long-lived dependencies passed to the reconcile flow. */
export interface ReconcileFlowDeps {
  readonly ctx: TaskStoreContext;
  /**
   * Optional override for the `git worktree list` resolver. Defaults to
   * {@link loadProjectWorktrees} driven by a local `ShellAdapter`.
   */
  readonly loadWorktrees?: LoadWorktreesFn;
  /**
   * Shell used when `loadWorktrees` is not injected. Defaults to
   * `createLocalShellAdapter()`.
   */
  readonly shell?: ShellAdapter;
}

//#endregion

//#region Constants

const RECONCILE_TICK_INTERVAL_MS = 60_000;

//#endregion

//#region Steps

/**
 * Build the per-tick `step.run` that drives one reconcile pass. Captured in a
 * factory so the deps are bound when the flow is constructed; the resulting
 * step takes `void` input.
 */
export function buildReconcileTickStep(
  deps: ReconcileFlowDeps,
): Step<ContextMemory, void, ReconcileTasksFsResult> {
  const shell = deps.shell ?? createLocalShellAdapter();
  const loadWorktrees: LoadWorktreesFn =
    deps.loadWorktrees ?? ((projectRoot) => loadProjectWorktrees(projectRoot, shell));
  return step.run<ContextMemory, void, ReconcileTasksFsResult>({
    id: 'reconcile.tick',
    execute: async (): Promise<ReconcileTasksFsResult> => {
      const worktrees = await loadWorktrees(deps.ctx.projectRoot);
      return reconcileTasksFs(deps.ctx, worktrees);
    },
  });
}

//#endregion

//#region Public API

/**
 * Build the reconcile `every` for the daemon flow. The body runs every
 * `60_000` ms; `onError: 'continue'` keeps the daemon up across transient
 * git failures (the next tick reconciles whatever was missed).
 */
export function buildReconcileEvery(
  deps: ReconcileFlowDeps,
): ReturnType<typeof every<ContextMemory, void, void>> {
  const tickWithReport = buildReconcileTickStep(deps);
  const tickVoid = step.run<ContextMemory, void, void>({
    id: 'reconcile.tick.void',
    execute: async (_input, ctx): Promise<void> => {
      await ctx.harness.run(tickWithReport, undefined, ctx);
    },
  });
  return every<ContextMemory, void, void>({
    id: 'reconcile.every',
    step: tickVoid,
    ms: RECONCILE_TICK_INTERVAL_MS,
    onError: 'continue',
  });
}

//#endregion
