import { basename, join } from 'node:path';
import type { FsAdapter } from '@noetic/core';
import { createLocalFsAdapter } from '@noetic/core';

import type { TaskStoreContext } from '../fs-store.js';
import { appendLog } from '../fs-store.js';
import { taskDirPaths } from '../paths.js';
import type { LogEntry } from '../schemas.js';
import { LogEntryKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

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

//#region Public API

/**
 * Copy `sourcePath` into `<taskDir>/attachments/<basename>` and record
 * the attachment in the task's log. The destination uses
 * `ctx.fs.writeFile`, so MemFs-backed tests round-trip without
 * touching real disk.
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
  const destination = join(paths.attachments, fileName);
  const contents = await sourceFs.readFile(args.sourcePath);
  await ctx.fs.writeFile(destination, contents.toString('utf-8'));
  const entry: LogEntry = {
    kind: LogEntryKind.System,
    ts: nowIso(),
    message: `Attached ${fileName}`,
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
