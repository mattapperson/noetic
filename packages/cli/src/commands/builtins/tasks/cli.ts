/**
 * `noetic tasks <verb>` dispatcher. Each verb is a small wrapper that
 * parses its slice of `argv`, hands off to the matching handler in
 * `./handlers/`, and writes a CLI-friendly representation of the
 * result. The dispatcher is exported as `runTasksCli(argv, opts?)` so
 * the top-level `cli.ts` can route into it; an
 * `if (import.meta.main)` foot guards a direct `bun run` invocation.
 */

import { TaskSource } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { resolveSubprocessRoot } from '@noetic/code-agent/tasks/store/fs-node';
import type { FsAdapter } from '@noetic/core';
import { createFileStorage } from '@noetic/core';
import { createLocalFsAdapter, createLocalSubprocessAdapter } from '@noetic/core/adapters/node';
import { ensureDaemon } from '../../../daemon-runtime/runtime.js';
import { formatError, requireProjectRoot } from './handlers/_shared.js';
import { autopilotHandler, steerTaskHandler } from './handlers/autopilot.js';
import {
  activateSliceHandler,
  addAssertionHandler,
  addFeatureHandler,
  addMilestoneHandler,
  addSliceHandler,
} from './handlers/hierarchy.js';
import {
  commentTaskHandler,
  listTasksHandler,
  logsTaskHandler,
  logTaskHandler,
  showTaskHandler,
} from './handlers/inspection.js';
import {
  archiveTaskHandler,
  createTaskHandler,
  deleteTaskHandler,
  duplicateTaskHandler,
  unarchiveTaskHandler,
} from './handlers/lifecycle.js';
import {
  attachTaskHandler,
  mergeTaskHandler,
  moveTaskHandler,
  pauseTaskHandler,
  unpauseTaskHandler,
} from './handlers/state.js';
import { KanbanColumn } from './kanban.js';

//#region Types

/** Minimal write-side stream surface used by the dispatcher. */
export interface CliWritable {
  write(chunk: string): unknown;
}

/** Stream-like interface for the dispatcher's stdout/stderr channels. */
export interface CliStreams {
  readonly stdout: CliWritable;
  readonly stderr: CliWritable;
}

export interface RunTasksCliOptions {
  /** Override `process.stdout`/`process.stderr` for tests. */
  readonly streams?: CliStreams;
  /** Override the project root resolution. Defaults to `requireProjectRoot()`. */
  readonly projectRoot?: string;
  /**
   * Override the tasks-root. Defaults to resolving via `NOETIC_HOME`
   * env or `~/.noetic/tasks`. Tests usually want this pinned to a
   * temp dir so they don't share `$HOME/.noetic/tasks` with each other.
   */
  readonly tasksRoot?: string;
  /** Override the FsAdapter. Defaults to `createLocalFsAdapter()`. */
  readonly fs?: FsAdapter;
}

type Verb = (
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
) => Promise<void>;

interface VerbDescriptor {
  readonly summary: string;
  readonly run: Verb;
}

//#endregion

//#region Tiny argv parser

interface ParsedArgv {
  readonly positional: ReadonlyArray<string>;
  readonly flags: ReadonlyMap<string, string | true>;
}

function parseArgv(argv: ReadonlyArray<string>): ParsedArgv {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const equalsIdx = token.indexOf('=');
    if (equalsIdx !== -1) {
      flags.set(token.slice(2, equalsIdx), token.slice(equalsIdx + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(key, true);
      continue;
    }
    flags.set(key, next);
    i += 1;
  }
  return {
    positional,
    flags,
  };
}

function requireString(parsed: ParsedArgv, name: string, fallbackPos?: number): string {
  const flag = parsed.flags.get(name);
  if (typeof flag === 'string' && flag.length > 0) {
    return flag;
  }
  if (fallbackPos !== undefined) {
    const positional = parsed.positional[fallbackPos];
    if (positional !== undefined && positional.length > 0) {
      return positional;
    }
  }
  throw new Error(`Missing required --${name} argument`);
}

function optionalString(parsed: ParsedArgv, name: string): string | undefined {
  const flag = parsed.flags.get(name);
  if (typeof flag === 'string') {
    return flag;
  }
  return undefined;
}

function booleanFlag(parsed: ParsedArgv, name: string): boolean {
  return parsed.flags.has(name);
}

//#endregion

//#region Output helpers

function write(stream: CliWritable, text: string): void {
  stream.write(text);
}

function writeJson(stream: CliWritable, value: unknown): void {
  write(stream, `${JSON.stringify(value, null, 2)}\n`);
}

const KANBAN_COLUMN_VALUES = new Set<string>(Object.values(KanbanColumn));
const TASK_SOURCE_VALUES = new Set<string>(Object.values(TaskSource));

function isKanbanColumn(value: string): value is KanbanColumn {
  return KANBAN_COLUMN_VALUES.has(value);
}

function isTaskSource(value: string): value is TaskSource {
  return TASK_SOURCE_VALUES.has(value);
}

function parseKanbanColumn(raw: string): KanbanColumn {
  if (!isKanbanColumn(raw)) {
    throw new Error(`Unknown kanban column: ${raw}`);
  }
  return raw;
}

function parseTaskSource(raw: string): TaskSource {
  if (!isTaskSource(raw)) {
    throw new Error(`Unknown task source: ${raw}`);
  }
  return raw;
}

function parseBool(raw: string): boolean {
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') {
    return true;
  }
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') {
    return false;
  }
  throw new Error(`Expected boolean (got: ${raw})`);
}

//#endregion

//#region Verb implementations

async function handleCreate(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const title = requireString(parsed, 'title', 0);
  const description = optionalString(parsed, 'description');
  const result = await createTaskHandler(ctx, {
    title,
    description,
  });
  writeJson(streams.stdout, result.task);
}

async function handleShow(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const tail = optionalString(parsed, 'tail');
  const result = await showTaskHandler(ctx, {
    taskId,
    logTail: tail !== undefined ? Number.parseInt(tail, 10) : undefined,
  });
  writeJson(streams.stdout, result);
}

async function handleList(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const column = optionalString(parsed, 'column');
  const source = optionalString(parsed, 'source');
  const result = await listTasksHandler(ctx, {
    column: column !== undefined ? parseKanbanColumn(column) : undefined,
    source: source !== undefined ? parseTaskSource(source) : undefined,
    all: booleanFlag(parsed, 'all'),
    terminal: booleanFlag(parsed, 'terminal'),
  });
  writeJson(streams.stdout, result.tasks);
}

async function handleMove(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const column = parseKanbanColumn(requireString(parsed, 'column', 1));
  const result = await moveTaskHandler(ctx, {
    taskId,
    column,
    force: booleanFlag(parsed, 'force'),
  });
  writeJson(streams.stdout, result);
}

async function handleMerge(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const result = await mergeTaskHandler(ctx, {
    taskId,
    branch: optionalString(parsed, 'branch'),
  });
  writeJson(streams.stdout, result);
}

async function handleLog(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const message = requireString(parsed, 'message', 1);
  const result = await logTaskHandler(ctx, {
    taskId,
    message,
  });
  writeJson(streams.stdout, result.entry);
}

async function handleLogs(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const n = optionalString(parsed, 'n');
  const result = await logsTaskHandler(ctx, {
    taskId,
    n: n !== undefined ? Number.parseInt(n, 10) : undefined,
  });
  writeJson(streams.stdout, result.entries);
}

async function handleAttach(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const sourcePath = requireString(parsed, 'file', 1);
  const result = await attachTaskHandler(ctx, {
    taskId,
    sourcePath,
  });
  writeJson(streams.stdout, result);
}

async function handleComment(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const message = requireString(parsed, 'message', 1);
  const result = await commentTaskHandler(ctx, {
    taskId,
    message,
  });
  writeJson(streams.stdout, result.entry);
}

async function handleSteer(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const message = requireString(parsed, 'message', 1);
  const result = await steerTaskHandler(ctx, {
    taskId,
    message,
  });
  writeJson(streams.stdout, result);
}

async function handlePause(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const result = await pauseTaskHandler(ctx, {
    taskId,
  });
  writeJson(streams.stdout, result.outcome);
}

async function handleUnpause(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const result = await unpauseTaskHandler(ctx, {
    taskId,
  });
  writeJson(streams.stdout, result.outcome);
}

async function handleArchive(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const result = await archiveTaskHandler(ctx, {
    taskId,
  });
  writeJson(streams.stdout, result.task);
}

async function handleUnarchive(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const result = await unarchiveTaskHandler(ctx, {
    taskId,
  });
  writeJson(streams.stdout, result.task);
}

async function handleDelete(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  // One-shot CLI invocation: spin up a durable-storage-backed subprocess
  // adapter purely to consult the live-handle manifest so delete-guards
  // see planner/implementer runners spawned by the TUI/daemon that
  // share the same `~/.noetic/subprocess` store.
  const subprocess = createLocalSubprocessAdapter({
    storage: createFileStorage({
      root: resolveSubprocessRoot(),
    }),
  });
  const result = await deleteTaskHandler(ctx, {
    taskId,
    subprocess,
    force: booleanFlag(parsed, 'force'),
  });
  writeJson(streams.stdout, result);
}

async function handleDuplicate(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const result = await duplicateTaskHandler(ctx, {
    taskId,
    title: optionalString(parsed, 'title'),
  });
  writeJson(streams.stdout, result.task);
}

async function handlePlan(
  _ctx: TaskStoreContext,
  _argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  // The live interview requires the chat-TUI's AskUserService for question
  // rendering; the headless CLI cannot invoke it directly. The TUI integration
  // calls `planTaskHandler` with a UI-backed `runInterview` — surfacing a clear
  // error here ensures users reach the correct entry point.
  write(
    streams.stderr,
    'tasks plan must be invoked from the interactive TUI; use /tasks plan there.\n',
  );
  throw new Error('tasks plan is not available in headless CLI mode');
}

async function handleAddMilestone(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const title = requireString(parsed, 'title');
  const verification = requireString(parsed, 'verification');
  const result = await addMilestoneHandler(ctx, {
    taskId,
    title,
    verification,
    description: optionalString(parsed, 'description'),
  });
  writeJson(streams.stdout, result.milestone);
}

async function handleAddSlice(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const milestoneId = requireString(parsed, 'milestone');
  const title = requireString(parsed, 'title');
  const verification = requireString(parsed, 'verification');
  const result = await addSliceHandler(ctx, {
    taskId,
    milestoneId,
    title,
    verification,
    description: optionalString(parsed, 'description'),
  });
  writeJson(streams.stdout, result.slice);
}

async function handleAddFeature(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const sliceId = requireString(parsed, 'slice');
  const title = requireString(parsed, 'title');
  const acceptanceCriteria = requireString(parsed, 'acceptance');
  const result = await addFeatureHandler(ctx, {
    taskId,
    sliceId,
    title,
    acceptanceCriteria,
    description: optionalString(parsed, 'description'),
  });
  writeJson(streams.stdout, result.feature);
}

async function handleAddAssertion(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const milestoneId = requireString(parsed, 'milestone');
  const title = requireString(parsed, 'title');
  const assertion = requireString(parsed, 'assertion');
  const featureIdsRaw = optionalString(parsed, 'features');
  const featureIds = featureIdsRaw !== undefined ? featureIdsRaw.split(',') : undefined;
  const result = await addAssertionHandler(ctx, {
    taskId,
    milestoneId,
    title,
    assertion,
    featureIds,
  });
  writeJson(streams.stdout, result.assertion);
}

async function handleActivateSlice(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const sliceId = requireString(parsed, 'slice');
  const triageRaw = optionalString(parsed, 'triage');
  const result = await activateSliceHandler(ctx, {
    taskId,
    sliceId,
    triage: triageRaw !== undefined ? parseBool(triageRaw) : undefined,
  });
  writeJson(streams.stdout, result.outcome);
}

async function handleAutopilot(
  ctx: TaskStoreContext,
  argv: ReadonlyArray<string>,
  streams: CliStreams,
): Promise<void> {
  const parsed = parseArgv(argv);
  const taskId = requireString(parsed, 'task', 0);
  const enabled = parseBool(requireString(parsed, 'enabled', 1));
  const result = await autopilotHandler(ctx, {
    taskId,
    enabled,
  });
  writeJson(streams.stdout, result.task);
}

//#endregion

//#region Verb registry

const verbs: Record<string, VerbDescriptor> = {
  create: {
    summary: 'Create a manual task with --title (and optional --description).',
    run: handleCreate,
  },
  show: {
    summary: 'Print a task with recent log + hierarchy summary.',
    run: handleShow,
  },
  list: {
    summary:
      'List tasks. Filter with --column / --source; --terminal shows hidden terminal columns; --all shows everything (including archived).',
    run: handleList,
  },
  move: {
    summary: 'Move a task to another kanban column.',
    run: handleMove,
  },
  merge: {
    summary: 'Merge the task branch via wt; falls back to git merge.',
    run: handleMerge,
  },
  log: {
    summary: 'Append a log entry to a task.',
    run: handleLog,
  },
  logs: {
    summary: 'Tail the most recent log entries.',
    run: handleLogs,
  },
  attach: {
    summary: 'Attach a file to a task.',
    run: handleAttach,
  },
  comment: {
    summary: 'Append a comment-kind log entry.',
    run: handleComment,
  },
  steer: {
    summary: 'Append a steering directive (also recorded in steering.md).',
    run: handleSteer,
  },
  pause: {
    summary: 'Pause the active agent-ci runner for a task.',
    run: handlePause,
  },
  unpause: {
    summary: 'Resume a paused agent-ci runner.',
    run: handleUnpause,
  },
  archive: {
    summary: 'Archive a task.',
    run: handleArchive,
  },
  unarchive: {
    summary: 'Unarchive a task.',
    run: handleUnarchive,
  },
  delete: {
    summary: 'Hard-delete a task.',
    run: handleDelete,
  },
  duplicate: {
    summary: 'Duplicate a task (description + attachments only).',
    run: handleDuplicate,
  },
  plan: {
    summary: 'Run the live interview to plan a task hierarchy (TUI-only).',
    run: handlePlan,
  },
  'add-milestone': {
    summary: 'Append a milestone to a task hierarchy.',
    run: handleAddMilestone,
  },
  'add-slice': {
    summary: 'Append a slice under an existing milestone.',
    run: handleAddSlice,
  },
  'add-feature': {
    summary: 'Append a feature under an existing slice.',
    run: handleAddFeature,
  },
  'add-assertion': {
    summary: 'Append an assertion under an existing milestone.',
    run: handleAddAssertion,
  },
  'activate-slice': {
    summary: 'Mark a slice active and (optionally) triage its features.',
    run: handleActivateSlice,
  },
  autopilot: {
    summary: 'Toggle the autopilot flag for a task.',
    run: handleAutopilot,
  },
};

//#endregion

//#region Help

function printHelp(stream: CliWritable): void {
  write(stream, 'Usage: noetic tasks <verb> [...args]\n\nAvailable verbs:\n');
  const orderedNames = Object.keys(verbs).sort();
  for (const name of orderedNames) {
    const descriptor = verbs[name];
    if (descriptor === undefined) {
      continue;
    }
    write(stream, `  ${name.padEnd(18, ' ')} ${descriptor.summary}\n`);
  }
}

//#endregion

//#region Public entry point

/**
 * Entry point for `noetic tasks <verb>`. Returns `0` on success and
 * `1` on any error (unknown verb, missing argument, handler throw).
 * Streams default to `process.stdout` / `process.stderr`.
 */
export async function runTasksCli(
  argv: ReadonlyArray<string>,
  options: RunTasksCliOptions = {},
): Promise<number> {
  const streams: CliStreams = options.streams ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  };

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp(streams.stdout);
    return 0;
  }

  const verbName = argv[0] ?? '';
  const descriptor = verbs[verbName];
  if (descriptor === undefined) {
    write(streams.stderr, `Unknown verb: ${verbName}\n`);
    printHelp(streams.stderr);
    return 1;
  }

  const projectRoot = options.projectRoot ?? requireProjectRoot();
  const fs = options.fs ?? createLocalFsAdapter();
  const ctx: TaskStoreContext = {
    projectRoot,
    fs,
    tasksRoot: options.tasksRoot,
  };

  // Auto-start the background daemon (autopilot / validator / health /
  // reconcile) so CLI verbs see the same orchestration as the
  // interactive TUI. Skipped when we ARE the daemon child (avoids a
  // recursive spawn) or when tests inject a custom fs/projectRoot.
  if (process.env.NOETIC_DAEMON !== '1' && options.projectRoot === undefined) {
    try {
      ensureDaemon(projectRoot);
    } catch (err) {
      write(streams.stderr, `[warn] [tasks daemon] startup failed: ${formatError(err)}\n`);
    }
  }

  try {
    await descriptor.run(ctx, argv.slice(1), streams);
    return 0;
  } catch (err) {
    write(streams.stderr, `${formatError(err)}\n`);
    return 1;
  }
}

//#endregion

//#region Script entry point

if (import.meta.main) {
  runTasksCli(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}

//#endregion
