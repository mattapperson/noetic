/**
 * Append-only persistence for a task's agent-chat history.
 *
 * Stored at `<taskDir>/chat.jsonl` — one core `Item` per line. The runner
 * subscribes to `harness.getItemStream()` and appends every new item;
 * on the next runner spawn, the file is replayed via
 * `harness.seedSessionHistory(threadId, items)` so the conversation
 * survives subprocess restarts.
 *
 * Items are not strictly schema-validated on read because the core `Item`
 * union is a tagged-union type with extension-item escape hatches; validating
 * here would couple this module to every extension schema. Lines that fail
 * `JSON.parse` are skipped with a single warning rather than aborting the
 * read, since a partial chat history is more useful than a hard failure.
 */

import type { FsAdapter, Item } from '@noetic/core';

import { isEnoent } from './_fs-errors.js';
import type { TasksRootCtx } from './paths.js';
import { taskDirPaths } from './paths.js';

//#region Types

export interface ChatHistoryStoreContext extends TasksRootCtx {
  readonly fs: FsAdapter;
  readonly projectRoot: string;
}

//#endregion

//#region Helpers

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isItemLike(value: unknown): value is Item {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.type === 'string';
}

function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

//#endregion

//#region Public API

/**
 * Append a single item to `<taskDir>/chat.jsonl`. Creates the task directory
 * lazily on first call. Atomic with respect to concurrent appends within a
 * single process because the underlying fs adapter serialises append calls.
 */
export async function appendChatItem(
  ctx: ChatHistoryStoreContext,
  taskId: string,
  item: Item,
): Promise<void> {
  const paths = taskDirPaths(ctx, taskId);
  await ctx.fs.mkdir(paths.dir);
  await ctx.fs.appendFile(paths.chat, encodeLine(item));
}

/**
 * Read the entire chat history, in append order. Returns `[]` if the file
 * is missing. Lines that don't parse as objects with a string `type` are
 * skipped — see module doc for the rationale.
 */
export async function readChatHistory(
  ctx: ChatHistoryStoreContext,
  taskId: string,
): Promise<Item[]> {
  const paths = taskDirPaths(ctx, taskId);
  let raw: string;
  try {
    raw = await ctx.fs.readFileText(paths.chat);
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }
  const items: Item[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isItemLike(parsed)) {
      continue;
    }
    items.push(parsed);
  }
  return items;
}

/**
 * Truncate the chat history. Used by tests and by the `task delete` path.
 */
export async function clearChatHistory(
  ctx: ChatHistoryStoreContext,
  taskId: string,
): Promise<void> {
  const paths = taskDirPaths(ctx, taskId);
  try {
    await ctx.fs.rm(paths.chat, {
      force: true,
    });
  } catch (err) {
    if (isEnoent(err)) {
      return;
    }
    throw err;
  }
}

//#endregion
