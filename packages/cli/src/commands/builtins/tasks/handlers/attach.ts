import { basename, format, join, parse } from 'node:path';
import type { FsAdapter } from '@noetic/core';
import { createLocalFsAdapter } from '@noetic/core';

import { isEnoent } from '../_fs-errors.js';
import type { TaskStoreContext } from '../fs-store.js';
import { appendLog } from '../fs-store.js';
import { taskDirPaths } from '../paths.js';
import type { LogEntry } from '../schemas.js';
import { LogEntryKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Constants

const MAX_RENAME_TRIES = 1_000;

//#endregion

//#region Types

export interface AttachTaskArgs {
  readonly taskId: string;
  /** Absolute path to the file the user wants to attach. */
  readonly sourcePath: string;
  /**
   * Optional `FsAdapter` for reading the source file. Defaults to a
   * fresh local adapter so the handler stays self-sufficient outside
   * tests.
   */
  readonly sourceFs?: FsAdapter;
}

export interface AttachTaskResult {
  readonly attachmentPath: string;
  readonly entry: LogEntry;
}

//#endregion

//#region Helpers

async function pathExists(ctx: TaskStoreContext, p: string): Promise<boolean> {
  try {
    await ctx.fs.access(p);
    return true;
  } catch (err) {
    if (isEnoent(err)) {
      return false;
    }
    throw err;
  }
}

/**
 * Pick a destination filename inside `dir` that doesn't already exist.
 * Appends ` (N)` before the extension on conflict (e.g. `foo.png` →
 * `foo (1).png` → `foo (2).png` → ...). Caps tries at `MAX_RENAME_TRIES`
 * to bound the search.
 */
async function uniqueDestinationPath(
  ctx: TaskStoreContext,
  dir: string,
  fileName: string,
): Promise<string> {
  const candidate = join(dir, fileName);
  if (!(await pathExists(ctx, candidate))) {
    return candidate;
  }
  const parsed = parse(fileName);
  for (let n = 1; n <= MAX_RENAME_TRIES; n++) {
    const next = format({
      dir,
      name: `${parsed.name} (${n})`,
      ext: parsed.ext,
    });
    if (!(await pathExists(ctx, next))) {
      return next;
    }
  }
  throw new Error(
    `Refusing to attach ${fileName}: ${MAX_RENAME_TRIES} conflict candidates already exist in ${dir}`,
  );
}

//#endregion

//#region Public API

/**
 * Copy `sourcePath` into `<taskDir>/attachments/<basename>` and record
 * the attachment in the task's log. Writes via `writeFileBytes` so
 * binary attachments (images, PDFs, etc.) round-trip byte-identically.
 * On a basename collision in the destination dir, the new file is
 * suffixed with ` (N)` before the extension instead of overwriting.
 */
export async function attachTaskHandler(
  ctx: TaskStoreContext,
  args: AttachTaskArgs,
): Promise<AttachTaskResult> {
  await resolveTask(ctx, args.taskId);
  const sourceFs = args.sourceFs ?? createLocalFsAdapter();
  const fileName = basename(args.sourcePath);
  if (fileName.length === 0) {
    throw new Error(`Cannot derive a file name from source path ${args.sourcePath}`);
  }
  const paths = taskDirPaths(ctx.projectRoot, args.taskId);
  await ctx.fs.mkdir(paths.attachments);
  const destination = await uniqueDestinationPath(ctx, paths.attachments, fileName);
  const contents = await sourceFs.readFile(args.sourcePath);
  await ctx.fs.writeFileBytes(destination, contents);
  const entry: LogEntry = {
    kind: LogEntryKind.System,
    ts: nowIso(),
    message: `Attached ${basename(destination)}`,
    meta: {
      attachmentPath: destination,
      sourcePath: args.sourcePath,
    },
  };
  await appendLog(ctx, {
    taskId: args.taskId,
    entry,
  });
  return {
    attachmentPath: destination,
    entry,
  };
}

//#endregion
