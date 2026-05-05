/**
 * Live-task handle lookup keyed by task id + task role.
 *
 * The tasks runner used to track running planner/implementer
 * subprocesses via sidecar JSON files (`_planner.json`,
 * `_implementer.json`) written by the launcher and cleared by the
 * runner on exit. Phase A2 replaced that ad-hoc sidecar scheme with
 * the `SubprocessAdapter.listLive()` manifest — every durable handle
 * carries a `metadata.taskRole` + `metadata.taskId` tag that uniquely
 * identifies its role in the task hierarchy.
 *
 * This module centralises the lookup so callers (delete guards,
 * pause/cancel, kanban, chat-target resolution) don't each have to
 * filter the handle list by hand. The old sidecar functions continue
 * to work during the transition — `findLiveTaskHandle` is the
 * forward-compatible entry point that Phase D will make canonical
 * once every caller has migrated.
 */

import type { SubprocessAdapter, SubprocessHandle } from '@noetic/core';

//#region Types

/**
 * Role tag stored on handle metadata. Every runner kind the tasks
 * system spawns gets a distinct literal so filtering by role is a
 * pure equality check.
 */
export const TaskRole = {
  Planner: 'planner',
  Implementer: 'implementer',
} as const;

export type TaskRole = (typeof TaskRole)[keyof typeof TaskRole];

export interface FindLiveTaskHandleOpts {
  readonly adapter: SubprocessAdapter;
  readonly taskId: string;
  readonly taskRole: TaskRole;
  /**
   * Optional extra disambiguator for roles that can spawn multiple
   * concurrent instances per task. The implementer runner spawns one
   * subprocess per feature, so `featureId` picks the right handle.
   * Omit for singleton roles (planner).
   */
  readonly featureId?: string;
}

//#endregion

//#region Helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readMetadataString(
  handle: SubprocessHandle,
  key: 'taskRole' | 'taskId' | 'featureId',
): string | null {
  const metadata = handle.metadata;
  if (!isRecord(metadata)) {
    return null;
  }
  const value = metadata[key];
  return typeof value === 'string' ? value : null;
}

function matchesTaskAndRole(handle: SubprocessHandle, taskId: string, taskRole: TaskRole): boolean {
  if (readMetadataString(handle, 'taskId') !== taskId) {
    return false;
  }
  if (readMetadataString(handle, 'taskRole') !== taskRole) {
    return false;
  }
  return true;
}

//#endregion

//#region Public API

/**
 * Find the live subprocess handle for `(taskId, taskRole[, featureId])`,
 * or null when no such runner is currently tracked by the adapter.
 *
 * The adapter's `listLive()` scans its persisted handle manifest
 * (in-memory for `createInMemorySubprocessAdapter`, on-disk for
 * `createLocalSubprocessAdapter` when given a durable storage). Every
 * manifest entry carries `metadata.taskRole` + `metadata.taskId` set
 * by the launcher at spawn time — matching both is the canonical
 * replacement for the pre-Phase-A2 sidecar reads.
 */
export async function findLiveTaskHandle(
  opts: FindLiveTaskHandleOpts,
): Promise<SubprocessHandle | null> {
  const handles = await opts.adapter.listLive();
  for (const handle of handles) {
    if (!matchesTaskAndRole(handle, opts.taskId, opts.taskRole)) {
      continue;
    }
    if (opts.featureId !== undefined) {
      if (readMetadataString(handle, 'featureId') !== opts.featureId) {
        continue;
      }
    }
    return handle;
  }
  return null;
}

/**
 * Return every live handle for the given `taskId` across all task
 * roles. Useful for delete-guards that need to know whether ANY
 * runner is still attached to a task before allowing removal.
 */
export async function listLiveTaskHandles(
  adapter: SubprocessAdapter,
  taskId: string,
): Promise<ReadonlyArray<SubprocessHandle>> {
  const handles = await adapter.listLive();
  const matched: SubprocessHandle[] = [];
  for (const handle of handles) {
    if (readMetadataString(handle, 'taskId') === taskId) {
      matched.push(handle);
    }
  }
  return matched;
}

//#endregion
