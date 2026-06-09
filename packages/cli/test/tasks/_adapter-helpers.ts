/**
 * Shared `SubprocessAdapter` test helpers for task-runner migration.
 *
 * Phase E replaced the legacy `spawnFn` / `provisionFn` injection seams
 * with full `SubprocessAdapter` mocks. These helpers centralise the two
 * recurring patterns:
 *
 * 1. **`makeTrackingAdapter`** — wraps `createInMemorySubprocessAdapter`
 *    to (a) inject synchronous `pid` / `pidStarttime` metadata so the
 *    launcher's post-spawn pid probe succeeds, (b) keep process handles
 *    in `running` state indefinitely (the in-memory adapter auto-
 *    completes when no `run` hook is supplied; that races `listLive`
 *    assertions), and (c) record each spawn request for test assertions.
 *
 * 2. **`preloadLiveHandle`** — registers a "pretend already-running"
 *    handle on an adapter so tests that exercise the live-handle guard
 *    (delete, re-spawn refusal, chat-target resolution) see the manifest
 *    entry `listLive()` returns.
 *
 * `fakeProvision` is a convenience wrapper for the implementer launcher's
 * `provisionFn` seam — shared so multiple test files don't diverge on
 * the provisioner contract.
 */

import type {
  LauncherProvisionRequest,
  ProvisionWorktreeResult,
} from '@noetic-tools/code-agent/tasks';
import { ProvisionTool } from '@noetic-tools/code-agent/tasks';
import type {
  SubprocessAdapter,
  SubprocessHandle,
  SubprocessHandleMetadata,
  SubprocessRequest,
} from '@noetic-tools/core';
import { createInMemorySubprocessAdapter } from '@noetic-tools/core';

//#region Tracking adapter

/** @internal — helper constant for the default tracking pid. */
const DEFAULT_PID = 4242;

export interface MakeTrackingAdapterOpts {
  /** Static pid to stamp on every process-kind handle. Defaults to 4242. */
  readonly pid?: number;
  /** Static pidStarttime to stamp alongside pid. Defaults to null. */
  readonly pidStarttime?: string | null;
  /** Derive a pid from each request (takes precedence over `pid`). */
  readonly pidFor?: (request: SubprocessRequest) => number;
  /** Derive a pidStarttime from the chosen pid. Takes precedence over `pidStarttime`. */
  readonly pidStarttimeFor?: (pid: number) => string | null;
  /** When true (default), `isAlive(handle)` always returns true. */
  readonly alive?: boolean;
  /** When set, `spawn()` throws this error — lets tests exercise the error path. */
  readonly throwOnSpawn?: Error;
}

export interface TrackingAdapter {
  readonly adapter: SubprocessAdapter;
  readonly requests: ReadonlyArray<SubprocessRequest>;
  spawnCount(): number;
}

/**
 * Wrap an in-memory subprocess adapter with the metadata-injection +
 * stay-running semantics task launcher tests expect. Wraps (rather than
 * calling `createInMemorySubprocessAdapter` directly with `metadataInjector`)
 * because the tracking wrapper also counts calls and records request bodies —
 * those aren't part of the adapter contract.
 */
export function makeTrackingAdapter(opts: MakeTrackingAdapterOpts = {}): TrackingAdapter {
  const requests: SubprocessRequest[] = [];
  let count = 0;
  const alive = opts.alive ?? true;
  const staticPid = opts.pid ?? DEFAULT_PID;

  function resolvePid(request: SubprocessRequest): number {
    if (opts.pidFor) {
      return opts.pidFor(request);
    }
    return staticPid;
  }

  function resolvePidStarttime(pid: number): string | null {
    if (opts.pidStarttimeFor) {
      return opts.pidStarttimeFor(pid);
    }
    return opts.pidStarttime ?? null;
  }

  const inner = createInMemorySubprocessAdapter({
    metadataInjector: (request) => {
      if (request.kind === 'step') {
        return {};
      }
      const pid = resolvePid(request);
      return {
        pid,
        pidStarttime: resolvePidStarttime(pid),
      };
    },
    run: async () => {
      // Never resolves — the launcher spawn path completes synchronously
      // after `await spawn()` returns, so tests never need to wait on the
      // process to "exit". A later `stop()` transitions the handle.
      await new Promise<void>(() => {});
    },
  });

  const wrapped: SubprocessAdapter = {
    ...inner,
    spawn: async (request) => {
      count += 1;
      requests.push(request);
      if (opts.throwOnSpawn) {
        throw opts.throwOnSpawn;
      }
      return inner.spawn(request);
    },
    isAlive: async () => alive,
  };

  return {
    adapter: wrapped,
    requests,
    spawnCount: () => count,
  };
}

//#endregion

//#region Preloaded live handle

export interface PreloadLiveHandleOpts {
  readonly taskId: string;
  readonly role: 'planner' | 'implementer';
  readonly featureId?: string;
  readonly parentTaskId?: string;
  readonly pid?: number;
  readonly pidStarttime?: string | null;
}

/**
 * Register a "pretend already-running" handle on an in-memory adapter so
 * `listLive()` reports it. Used by tests that exercise live-handle guards
 * (delete guard, duplicate-spawn refusal, chat-target resolution).
 *
 * The adapter's `run` hook never resolves, so the handle stays in
 * `running` until a `stop()` call. That's essential for tests whose
 * assertions call `listLive()` after one or more awaits.
 */
export async function preloadLiveHandle(opts: PreloadLiveHandleOpts): Promise<SubprocessAdapter> {
  const tracker = makeTrackingAdapter({
    pid: opts.pid ?? 5151,
    pidStarttime: opts.pidStarttime ?? null,
  });
  const metadata: SubprocessHandleMetadata = {
    taskRole: opts.role,
    taskId: opts.taskId,
  };
  if (opts.featureId !== undefined) {
    metadata.featureId = opts.featureId;
  }
  if (opts.parentTaskId !== undefined) {
    metadata.parentTaskId = opts.parentTaskId;
  }
  const handle: SubprocessHandle = await tracker.adapter.spawn({
    kind: 'process',
    command: 'stub',
    metadata,
  });
  void handle;
  return tracker.adapter;
}

export interface PreloadedHandleSpec {
  readonly role: 'planner' | 'implementer';
  readonly taskId: string;
  readonly featureId?: string;
}

/**
 * Batch variant of `preloadLiveHandle` for tests that need multiple
 * handles registered on the same adapter (e.g. planner + implementer
 * both live for the same task).
 */
export async function preloadLiveHandles(
  specs: ReadonlyArray<PreloadedHandleSpec>,
): Promise<SubprocessAdapter> {
  const tracker = makeTrackingAdapter({
    pid: 1,
  });
  for (const spec of specs) {
    const metadata: SubprocessHandleMetadata = {
      taskRole: spec.role,
      taskId: spec.taskId,
    };
    if (spec.featureId !== undefined) {
      metadata.featureId = spec.featureId;
    }
    const handle: SubprocessHandle = await tracker.adapter.spawn({
      kind: 'process',
      command: 'stub',
      metadata,
    });
    void handle;
  }
  return tracker.adapter;
}

//#endregion

//#region Empty adapter

/**
 * Shorthand for a tracking adapter with default options — use when a test
 * just needs "some adapter that doesn't blow up when spawn() is called."
 * Handles stay in `running` so ambient `listLive()` calls see them.
 */
export function makeEmptySubprocess(): SubprocessAdapter {
  return makeTrackingAdapter().adapter;
}

//#endregion

//#region Provision stub

/**
 * Deterministic `provisionFn` for implementer launcher tests. Returns a
 * fake worktree path derived from the branch name so assertions can check
 * the branch-to-path mapping without hitting the filesystem.
 */
export function fakeProvision(): (
  args: LauncherProvisionRequest,
) => Promise<ProvisionWorktreeResult> {
  return async (args) => ({
    projectRoot: args.projectRoot,
    branch: args.branch,
    worktreePath: `.worktrees/${args.branch.replaceAll('/', '-')}`,
    tool: ProvisionTool.Git,
  });
}

//#endregion
