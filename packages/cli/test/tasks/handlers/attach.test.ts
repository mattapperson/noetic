import { describe, expect, it } from 'bun:test';

import { readLog } from '@noetic/code-agent/tasks/store/fs-node';
import { attachTaskHandler } from '../../../src/commands/builtins/tasks/handlers/attach.js';
import { createTaskHandler } from '../../../src/commands/builtins/tasks/handlers/create.js';
import { LogEntryKind } from '@noetic/code-agent/tasks/schema';
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

  it('round-trips binary attachments byte-identically (no UTF-8 corruption)', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Binary attach',
    });

    const sourceFs = new MemFs([
      '/external',
    ]);
    // Bytes that are NOT valid UTF-8: 0xff 0xfe + a NUL + low ASCII.
    const sourceBytes = Buffer.from([
      0xff,
      0xfe,
      0x00,
      0x01,
      0x02,
      0x03,
      0x42,
      0x49,
      0x4e,
      0x41,
      0x52,
      0x59,
    ]);
    await sourceFs.writeFileBytes('/external/blob.bin', sourceBytes);

    const result = await attachTaskHandler(ctx, {
      taskId: created.task.id,
      sourcePath: '/external/blob.bin',
      sourceFs,
    });

    const copied = await ctx.fs.readFile(result.attachmentPath);
    expect(copied.equals(sourceBytes)).toBe(true);
  });

  it('suffixes the destination filename on basename collision', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Collide',
    });

    const aFs = new MemFs([
      '/a',
    ]);
    await aFs.writeFile('/a/notes.md', 'first');
    const bFs = new MemFs([
      '/b',
    ]);
    await bFs.writeFile('/b/notes.md', 'second');
    const cFs = new MemFs([
      '/c',
    ]);
    await cFs.writeFile('/c/notes.md', 'third');

    const r1 = await attachTaskHandler(ctx, {
      taskId: created.task.id,
      sourcePath: '/a/notes.md',
      sourceFs: aFs,
    });
    const r2 = await attachTaskHandler(ctx, {
      taskId: created.task.id,
      sourcePath: '/b/notes.md',
      sourceFs: bFs,
    });
    const r3 = await attachTaskHandler(ctx, {
      taskId: created.task.id,
      sourcePath: '/c/notes.md',
      sourceFs: cFs,
    });

    expect(r1.attachmentPath.endsWith('/notes.md')).toBe(true);
    expect(r2.attachmentPath.endsWith('/notes (1).md')).toBe(true);
    expect(r3.attachmentPath.endsWith('/notes (2).md')).toBe(true);

    expect(await ctx.fs.readFileText(r1.attachmentPath)).toBe('first');
    expect(await ctx.fs.readFileText(r2.attachmentPath)).toBe('second');
    expect(await ctx.fs.readFileText(r3.attachmentPath)).toBe('third');
  });
});
