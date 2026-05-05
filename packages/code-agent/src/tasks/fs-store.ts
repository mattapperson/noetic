import { randomBytes } from 'node:crypto';
import path from 'node:path';

import type { FsAdapter } from '@noetic/core';

import { isEnoent } from './_fs-errors.js';
import type { TasksRootCtx } from './paths.js';
import { taskDirPaths, taskRootPaths, tempPath } from './paths.js';
import type { Event, LogEntry, State, Task } from './schemas.js';
import {
  EventSchema,
  LOG_LINE_MAX_BYTES,
  LogEntrySchema,
  SCHEMA_VERSION,
  StateSchema,
  TaskIdSchema,
  TaskSchema,
} from './schemas.js';

//#region Types

/**
 * Bundle of dependencies the FS store reads/writes through.
 *
 * `projectRoot` is kept for non-task-state concerns — cwd for child
 * processes, git worktree roots, `noetic.config.ts` discovery — but is
 * no longer used to locate task records. Those live under a
 * user-global tasks root (`$HOME/.noetic/tasks` by default, override
 * via `NOETIC_HOME`, or pass `tasksRoot` on this context to pin it).
 * `TasksRootCtx` on the extends chain means every path-helper call
 * picks up whichever root is in effect without threading an extra arg.
 */
export interface TaskStoreContext extends TasksRootCtx {
  readonly fs: FsAdapter;
  readonly projectRoot: string;
}

export interface TailLogOptions {
  readonly taskId: string;
  /** Maximum number of recent entries to return (default 50). */
  readonly n?: number;
}

export interface AppendLogOptions {
  readonly taskId: string;
  readonly entry: Omit<LogEntry, 'chunk' | 'chunkCount'>;
}

//#endregion

//#region Helpers

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function exists(fs: FsAdapter, target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function randomSalt(): string {
  return randomBytes(6).toString('base64url');
}

/**
 * Write-temp-then-rename. The rename is atomic on POSIX, so readers never
 * observe a half-written file.
 */
async function atomicWrite(fs: FsAdapter, target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target));
  const tmp = tempPath(target, randomSalt());
  await fs.writeFile(tmp, content);
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, {
      force: true,
    });
    throw err;
  }
}

async function readJsonIfExists<T>(
  fs: FsAdapter,
  target: string,
  parse: (raw: unknown) => T,
): Promise<T | null> {
  let text: string;
  try {
    text = await fs.readFileText(target);
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }
  if (text.length === 0) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse JSON at ${target}: ${errorMessage(err)}`);
  }
  return parse(raw);
}

function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function chunkMessage(message: string, capBytes: number): string[] {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(message);
  if (bytes.length <= capBytes) {
    return [
      message,
    ];
  }
  const chunks: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(offset + capBytes, bytes.length);
    // Don't split mid-codepoint: walk back if we landed inside a UTF-8 continuation.
    while (end < bytes.length) {
      const b = bytes[end];
      if (b === undefined || (b & 0xc0) !== 0x80) {
        break;
      }
      end -= 1;
    }
    if (end <= offset) {
      // Pathological case (shouldn't happen for valid utf-8); force progress.
      end = Math.min(offset + capBytes, bytes.length);
    }
    chunks.push(decoder.decode(bytes.subarray(offset, end)));
    offset = end;
  }
  return chunks;
}

//#endregion

//#region State + events

/** Read the cross-process state file, returning a fresh default if absent. */
export async function loadState(ctx: TaskStoreContext): Promise<State> {
  const paths = taskRootPaths(ctx);
  const state = await readJsonIfExists<State>(ctx.fs, paths.state, (raw) => StateSchema.parse(raw));
  if (state === null) {
    return {
      schemaVersion: SCHEMA_VERSION,
      lastEventId: 0,
    };
  }
  return state;
}

async function saveState(ctx: TaskStoreContext, state: State): Promise<void> {
  const paths = taskRootPaths(ctx);
  await atomicWrite(ctx.fs, paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Append an event to `_events.jsonl` after bumping `_state.json#lastEventId`.
 *
 * Order is **state → event** so a tailer that reads up to a state's
 * `lastEventId` is guaranteed to find every event with `id <= lastEventId`.
 */
export async function appendEvent(ctx: TaskStoreContext, input: Omit<Event, 'id'>): Promise<Event> {
  const paths = taskRootPaths(ctx);
  const state = await loadState(ctx);
  const next: State = {
    schemaVersion: SCHEMA_VERSION,
    lastEventId: state.lastEventId + 1,
  };
  await saveState(ctx, next);
  const event: Event = EventSchema.parse({
    ...input,
    id: next.lastEventId,
  });
  await ctx.fs.mkdir(paths.root);
  await ctx.fs.appendFile(paths.events, encodeLine(event));
  return event;
}

/** Tail events with id strictly greater than `sinceId` (default 0). */
export async function tailEvents(ctx: TaskStoreContext, sinceId = 0): Promise<Event[]> {
  const paths = taskRootPaths(ctx);
  let raw: string;
  try {
    raw = await ctx.fs.readFileText(paths.events);
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }
  const events: Event[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const parsed = EventSchema.parse(JSON.parse(line));
    if (parsed.id <= sinceId) {
      continue;
    }
    events.push(parsed);
  }
  return events;
}

//#endregion

//#region Task CRUD

/** Persist `task.json` atomically. Caller is responsible for emitting any event. */
export async function saveTask(ctx: TaskStoreContext, task: Task): Promise<void> {
  const validated = TaskSchema.parse(task);
  const paths = taskDirPaths(ctx, validated.id);
  await atomicWrite(ctx.fs, paths.task, `${JSON.stringify(validated, null, 2)}\n`);
}

/** Load a task by id; throws if missing or malformed. */
export async function loadTask(ctx: TaskStoreContext, taskId: string): Promise<Task> {
  TaskIdSchema.parse(taskId);
  const paths = taskDirPaths(ctx, taskId);
  const task = await readJsonIfExists<Task>(ctx.fs, paths.task, (raw) => TaskSchema.parse(raw));
  if (task === null) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return task;
}

/** Best-effort lookup; returns null for missing or malformed records. */
export async function tryLoadTask(ctx: TaskStoreContext, taskId: string): Promise<Task | null> {
  if (!TaskIdSchema.safeParse(taskId).success) {
    return null;
  }
  const paths = taskDirPaths(ctx, taskId);
  try {
    return await readJsonIfExists<Task>(ctx.fs, paths.task, (raw) => TaskSchema.parse(raw));
  } catch {
    return null;
  }
}

/** List every well-formed task in the project. Bad entries are skipped. */
export async function listTasks(ctx: TaskStoreContext): Promise<Task[]> {
  const paths = taskRootPaths(ctx);
  let entries: string[];
  try {
    entries = await ctx.fs.readdir(paths.root);
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }
  const tasks: Task[] = [];
  for (const entry of entries) {
    if (entry.startsWith('_')) {
      continue;
    }
    if (!TaskIdSchema.safeParse(entry).success) {
      continue;
    }
    const task = await tryLoadTask(ctx, entry);
    if (task === null) {
      continue;
    }
    tasks.push(task);
  }
  return tasks;
}

/** Hard-delete the entire task directory. Caller emits any event. */
export async function deleteTaskDir(ctx: TaskStoreContext, taskId: string): Promise<void> {
  TaskIdSchema.parse(taskId);
  const paths = taskDirPaths(ctx, taskId);
  await ctx.fs.rm(paths.dir, {
    recursive: true,
    force: true,
  });
}

/** Whether the task carries a `hierarchy/` subdirectory. */
export async function hasHierarchy(ctx: TaskStoreContext, taskId: string): Promise<boolean> {
  const paths = taskDirPaths(ctx, taskId);
  return exists(ctx.fs, paths.hierarchy);
}

//#endregion

//#region Log

/**
 * Append a log entry to `<taskDir>/log.jsonl`. Messages exceeding
 * `LOG_LINE_MAX_BYTES` are split into chunked entries that share a single
 * timestamp; readers re-assemble by joining adjacent rows with the same
 * `ts` and incrementing `chunk`.
 */
export async function appendLog(ctx: TaskStoreContext, options: AppendLogOptions): Promise<void> {
  TaskIdSchema.parse(options.taskId);
  const paths = taskDirPaths(ctx, options.taskId);
  await ctx.fs.mkdir(paths.dir);
  const chunks = chunkMessage(options.entry.message, LOG_LINE_MAX_BYTES);
  if (chunks.length === 1) {
    const single = LogEntrySchema.parse({
      ...options.entry,
      message: chunks[0],
    });
    await ctx.fs.appendFile(paths.log, encodeLine(single));
    return;
  }
  let i = 1;
  for (const chunk of chunks) {
    const part = LogEntrySchema.parse({
      ...options.entry,
      message: chunk,
      chunk: i,
      chunkCount: chunks.length,
    });
    await ctx.fs.appendFile(paths.log, encodeLine(part));
    i += 1;
  }
}

/** Read every log entry in order. Returns [] if log file is missing. */
export async function readLog(ctx: TaskStoreContext, taskId: string): Promise<LogEntry[]> {
  TaskIdSchema.parse(taskId);
  const paths = taskDirPaths(ctx, taskId);
  let raw: string;
  try {
    raw = await ctx.fs.readFileText(paths.log);
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }
  const entries: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    entries.push(LogEntrySchema.parse(JSON.parse(line)));
  }
  return entries;
}

/** Tail the last `n` entries (default 50). */
export async function tailLog(ctx: TaskStoreContext, options: TailLogOptions): Promise<LogEntry[]> {
  const n = options.n ?? 50;
  const all = await readLog(ctx, options.taskId);
  if (all.length <= n) {
    return all;
  }
  return all.slice(all.length - n);
}

//#endregion
