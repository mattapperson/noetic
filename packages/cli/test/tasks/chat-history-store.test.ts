import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item } from '@noetic/core';
import { createLocalFsAdapter } from '@noetic/core';
import type { ChatHistoryStoreContext } from '../../src/commands/builtins/tasks/chat-history-store.js';
import {
  appendChatItem,
  clearChatHistory,
  readChatHistory,
} from '../../src/commands/builtins/tasks/chat-history-store.js';
import { taskDirPaths } from '../../src/commands/builtins/tasks/paths.js';

describe('chat-history-store', () => {
  let projectRoot: string;
  let ctx: ChatHistoryStoreContext;
  const TASK_ID = 'T-test001';

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'noetic-chat-store-'));
    ctx = {
      fs: createLocalFsAdapter(),
      projectRoot,
      tasksRoot: join(projectRoot, 'tasks'),
    };
  });

  afterEach(async () => {
    await rm(projectRoot, {
      recursive: true,
      force: true,
    });
  });

  function userMessage(id: string, text: string): Item {
    return {
      id,
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [
        {
          type: 'input_text',
          text,
        },
      ],
    };
  }

  it('returns [] when chat.jsonl does not exist', async () => {
    const items = await readChatHistory(ctx, TASK_ID);
    expect(items).toEqual([]);
  });

  it('appends items and reads them back in order', async () => {
    const a = userMessage('m1', 'hello');
    const b = userMessage('m2', 'world');
    await appendChatItem(ctx, TASK_ID, a);
    await appendChatItem(ctx, TASK_ID, b);
    const items = await readChatHistory(ctx, TASK_ID);
    expect(items.length).toBe(2);
    expect(items[0]).toEqual(a);
    expect(items[1]).toEqual(b);
  });

  it('writes one JSON object per line', async () => {
    await appendChatItem(ctx, TASK_ID, userMessage('m1', 'a'));
    await appendChatItem(ctx, TASK_ID, userMessage('m2', 'b'));
    const { chat } = taskDirPaths(ctx, TASK_ID);
    const text = await readFile(chat, 'utf8');
    const lines = text.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('skips malformed lines without aborting the read', async () => {
    await appendChatItem(ctx, TASK_ID, userMessage('m1', 'good'));
    const { chat } = taskDirPaths(ctx, TASK_ID);
    // Append a malformed line followed by a good one.
    await writeFile(
      chat,
      `${await readFile(chat, 'utf8')}{not json\n${JSON.stringify(userMessage('m2', 'after-bad'))}\n`,
    );
    const items = await readChatHistory(ctx, TASK_ID);
    expect(items.length).toBe(2);
    const first = items[0];
    const second = items[1];
    assert(first !== undefined && first.type === 'message');
    assert(second !== undefined && second.type === 'message');
    expect(first.id).toBe('m1');
    expect(second.id).toBe('m2');
  });

  it('skips parsed lines that are not item-like', async () => {
    await appendChatItem(ctx, TASK_ID, userMessage('m1', 'good'));
    const { chat } = taskDirPaths(ctx, TASK_ID);
    // Inject a line that parses as JSON but isn't an Item (no `type`).
    await writeFile(
      chat,
      `${await readFile(chat, 'utf8')}${JSON.stringify({
        foo: 'bar',
      })}\n`,
    );
    const items = await readChatHistory(ctx, TASK_ID);
    expect(items.length).toBe(1);
    const only = items[0];
    assert(only !== undefined && only.type === 'message');
    expect(only.id).toBe('m1');
  });

  it('clearChatHistory removes the file and is idempotent', async () => {
    await appendChatItem(ctx, TASK_ID, userMessage('m1', 'hi'));
    await clearChatHistory(ctx, TASK_ID);
    const items = await readChatHistory(ctx, TASK_ID);
    expect(items).toEqual([]);
    // Calling again with no file present is a no-op.
    await clearChatHistory(ctx, TASK_ID);
  });
});
