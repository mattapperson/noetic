import { describe, expect, it } from 'bun:test';

import { readLog } from '../../../src/commands/builtins/tasks/fs-store.js';
import { attachTaskHandler } from '../../../src/commands/builtins/tasks/handlers/attach.js';
import { createTaskHandler } from '../../../src/commands/builtins/tasks/handlers/create.js';
import { LogEntryKind } from '../../../src/commands/builtins/tasks/schemas.js';
import { MemFs, makeStoreContext } from '../_helpers.js';

describe('attachTaskHandler', () => {
  it('copies an external file into <taskDir>/attachments and logs it', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Attach target',
    });

    const sourceFs = new MemFs([
      '/external',
    ]);
    await sourceFs.writeFile('/external/notes.md', 'reproducer\n');

    const result = await attachTaskHandler(ctx, {
      taskId: created.task.id,
      sourcePath: '/external/notes.md',
      sourceFs,
    });

    expect(result.attachmentPath.endsWith('/notes.md')).toBe(true);
    const copied = await ctx.fs.readFileText(result.attachmentPath);
    expect(copied).toBe('reproducer\n');

    const log = await readLog(ctx, created.task.id);
    expect(log.length).toBe(1);
    expect(log[0]?.kind).toBe(LogEntryKind.System);
    expect(log[0]?.meta?.attachmentPath).toBe(result.attachmentPath);
  });

  it('throws when the target task does not exist', async () => {
    const ctx = makeStoreContext();
    const sourceFs = new MemFs([
      '/external',
    ]);
    await sourceFs.writeFile('/external/x.txt', 'hi');
    await expect(
      attachTaskHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
        sourcePath: '/external/x.txt',
        sourceFs,
      }),
    ).rejects.toThrow();
  });
});
