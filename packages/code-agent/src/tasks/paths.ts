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
  };
}

/** Default base directory for runner IPC sockets. */
export const DEFAULT_RUNTIME_DIR = '/tmp/.noetic';

/** Resolve the unix-domain-socket path for a single runner.
 *
 * `role` distinguishes the agent role; `runnerId` must be unique across
 * concurrent runners — for implementers it's the featureId, for planners
 * it's the taskId.
 *
 * macOS caps unix-domain socket paths at 104 bytes, so sockets default to
 * `/tmp/.noetic/<role>-<runnerId>.sock` rather than a path under the
 * project directory (which can easily blow the limit on deep homedirs).
 * Override the base via `NOETIC_RUNTIME_DIR`.
 */
export function runnerSocketPath(args: {
  readonly role: string;
  readonly runnerId: string;
}): string {
  const runtimeDir = process.env.NOETIC_RUNTIME_DIR;
  const baseDir =
    typeof runtimeDir === 'string' && runtimeDir.length > 0 ? runtimeDir : DEFAULT_RUNTIME_DIR;
  return join(baseDir, `${args.role}-${args.runnerId}.sock`);
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
