import { join } from 'node:path';

//#region Types

/** Paths shared across the project's task root. */
export interface TaskRootPaths {
  /** `<projectRoot>/.noetic/tasks` */
  readonly root: string;
  /** `<root>/_events.jsonl` cross-process event feed. */
  readonly events: string;
  /** `<root>/_state.json` (schemaVersion + monotonic event id). */
  readonly state: string;
}

/** Per-task on-disk layout. */
export interface TaskDirPaths {
  /** `<root>/<taskId>` */
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
  /** `<dir>/sockets/` runner IPC sockets (one per active runner). */
  readonly sockets: string;
}

//#endregion

//#region Helpers

/** Returns the `.noetic/tasks` root for a project. */
export function tasksRoot(projectRoot: string): string {
  return join(projectRoot, '.noetic', 'tasks');
}

export function taskRootPaths(projectRoot: string): TaskRootPaths {
  const root = tasksRoot(projectRoot);
  return {
    root,
    events: join(root, '_events.jsonl'),
    state: join(root, '_state.json'),
  };
}

export function taskDirPaths(projectRoot: string, taskId: string): TaskDirPaths {
  const dir = join(tasksRoot(projectRoot), taskId);
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

/** Resolve the unix-domain-socket path for a single runner.
 *
 * `role` distinguishes the agent role; `runnerId` distinguishes concurrent
 * runners of the same role (e.g. multiple implementers, one per feature).
 * For singletons (planner, validator) `runnerId` is the role itself.
 *
 * macOS caps unix-domain socket paths at 104 bytes — when a project lives
 * under a deep path, the default `<projectRoot>/.noetic/tasks/<taskId>/sockets/...`
 * blows the limit. Setting `NOETIC_RUNTIME_DIR=/tmp/n` (or any short base)
 * relocates the sockets dir to `<NOETIC_RUNTIME_DIR>/<taskId>/`. The on-disk
 * task store keeps using its long path; only the socket leaves.
 */
export function runnerSocketPath(args: {
  readonly projectRoot: string;
  readonly taskId: string;
  readonly role: string;
  readonly runnerId: string;
}): string {
  const runtimeDir = process.env.NOETIC_RUNTIME_DIR;
  if (typeof runtimeDir === 'string' && runtimeDir.length > 0) {
    return join(runtimeDir, args.taskId, `${args.role}-${args.runnerId}.sock`);
  }
  const { sockets } = taskDirPaths(args.projectRoot, args.taskId);
  return join(sockets, `${args.role}-${args.runnerId}.sock`);
}

/**
 * The temp file used as the source of write-temp-then-rename for atomic
 * publishes. The suffix carries random bits so concurrent writers don't
 * collide on the same temp path.
 */
export function tempPath(target: string, salt: string): string {
  return `${target}.tmp.${salt}`;
}

//#endregion
