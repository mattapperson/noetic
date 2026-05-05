import { homedir } from 'node:os';
import { join } from 'node:path';

//#region Types

/**
 * Minimal context for resolving task paths.
 *
 * Call sites that already have a `TaskStoreContext` pass it directly
 * — the `tasksRoot` field falls through. Tests can pass a bare
 * `{ tasksRoot: '/repo/.noetic/tasks' }` to redirect all task state
 * into a MemFs-friendly path without touching env vars.
 *
 * The index signature lets this interface sit cheaply on top of
 * richer context shapes (e.g. `TaskStoreContext`, component `opts`)
 * without requiring callers to destructure.
 */
export interface TasksRootCtx {
  /** Explicit tasks-root override. Wins over `NOETIC_HOME` and the default. */
  readonly tasksRoot?: string;
  readonly [key: string]: unknown;
}

/** Paths shared across every task on the machine. */
export interface TaskRootPaths {
  /** `$HOME/.noetic/tasks` (or override). */
  readonly root: string;
  /** `<root>/_events.jsonl` cross-task event feed. */
  readonly events: string;
  /** `<root>/_state.json` (schemaVersion + monotonic event id). */
  readonly state: string;
}

/** Per-task on-disk layout. */
export interface TaskDirPaths {
  /** `<tasksRoot>/<taskId>` */
  readonly dir: string;
  /** `<dir>/task.json` canonical record. */
  readonly task: string;
  /** `<dir>/description.md` long-form description. */
  readonly description: string;
  /** `<dir>/log.jsonl` append-only audit. */
  readonly log: string;
  /** `<dir>/steering.md` (optional). */
  readonly steering: string;
  /** `<dir>/attachments/` (optional). */
  readonly attachments: string;
  /** `<dir>/hierarchy/` (present iff structured). */
  readonly hierarchy: string;
  /** `<dir>/chat.jsonl` append-only chat history (one Item per line). */
  readonly chat: string;
  /** `<dir>/sockets/` runner IPC sockets (planner + concurrent implementers). */
  readonly sockets: string;
}

//#endregion

//#region Helpers

/**
 * Resolve the tasks-root directory.
 *
 * Precedence (highest first):
 *   1. Explicit `ctx.tasksRoot` (tests, tools with an injected root).
 *   2. `NOETIC_HOME` env var → `<NOETIC_HOME>/tasks`.
 *   3. Default: `$HOME/.noetic/tasks`.
 *
 * Task state is user-global — not project-relative — so a task
 * survives project moves, and the same task is addressable from any
 * cwd on the machine.
 */
export function resolveTasksRoot(ctx: TasksRootCtx = {}): string {
  if (typeof ctx.tasksRoot === 'string' && ctx.tasksRoot.length > 0) {
    return ctx.tasksRoot;
  }
  const env = process.env.NOETIC_HOME;
  if (typeof env === 'string' && env.length > 0) {
    return join(env, 'tasks');
  }
  return join(homedir(), '.noetic', 'tasks');
}

export function taskRootPaths(ctx: TasksRootCtx = {}): TaskRootPaths {
  const root = resolveTasksRoot(ctx);
  return {
    root,
    events: join(root, '_events.jsonl'),
    state: join(root, '_state.json'),
  };
}

export function taskDirPaths(ctx: TasksRootCtx, taskId: string): TaskDirPaths {
  const dir = join(resolveTasksRoot(ctx), taskId);
  return {
    dir,
    task: join(dir, 'task.json'),
    description: join(dir, 'description.md'),
    log: join(dir, 'log.jsonl'),
    steering: join(dir, 'steering.md'),
    attachments: join(dir, 'attachments'),
    hierarchy: join(dir, 'hierarchy'),
    chat: join(dir, 'chat.jsonl'),
    sockets: join(dir, 'sockets'),
  };
}

//#endregion

//#region Socket path

/**
 * Resolve the unix-domain-socket path for a single runner.
 *
 * Sockets live inside the per-task `sockets/` subdir so a task's
 * runner lifecycle is isolated to its own directory — removing a
 * task directory cleanly tears down every socket it owns.
 *
 * Filename conventions:
 *   - Singleton roles (planner): `planner.sock` (no runnerId suffix;
 *     there is only ever one planner per task).
 *   - Multi-instance roles (implementer): `implementer-<runnerId>.sock`,
 *     where `runnerId` is the feature id — concurrent implementers
 *     for different features on the same task coexist.
 *
 * macOS caps `sun_path` at 104 bytes. For typical home-dir paths the
 * full socket path stays well under the limit; the
 * `paths-home.test.ts` suite asserts this bound.
 */
export function runnerSocketPath(
  ctx: TasksRootCtx,
  args: {
    readonly taskId: string;
    readonly role: string;
    readonly runnerId?: string;
  },
): string {
  const { sockets } = taskDirPaths(ctx, args.taskId);
  const filename =
    args.runnerId === undefined ? `${args.role}.sock` : `${args.role}-${args.runnerId}.sock`;
  return join(sockets, filename);
}

//#endregion

//#region Misc

/**
 * The temp file used as the source of write-temp-then-rename for atomic
 * publishes. The suffix carries random bits so concurrent writers don't
 * collide on the same temp path.
 */
export function tempPath(target: string, salt: string): string {
  return `${target}.tmp.${salt}`;
}

//#endregion
