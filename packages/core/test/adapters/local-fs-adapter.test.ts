import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalFsAdapter } from '../../src/adapters/local-fs-adapter';

describe('createLocalFsAdapter', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'noetic-fs-adapter-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
    });
  });

  describe('writeFile / readFile / readFileText', () => {
    it('round-trips utf-8 content', async () => {
      const fs = createLocalFsAdapter();
      const file = join(dir, 'hello.txt');

      await fs.writeFile(file, 'héllo wörld');
      const buf = await fs.readFile(file);
      const text = await fs.readFileText(file);

      expect(buf.toString('utf-8')).toBe('héllo wörld');
      expect(text).toBe('héllo wörld');
    });

    it('overwrites on writeFile', async () => {
      const fs = createLocalFsAdapter();
      const file = join(dir, 'overwrite.txt');

      await fs.writeFile(file, 'first');
      await fs.writeFile(file, 'second');

      expect(await fs.readFileText(file)).toBe('second');
    });
  });

  describe('appendFile', () => {
    it('creates the file if it does not exist', async () => {
      const fs = createLocalFsAdapter();
      const file = join(dir, 'new.log');

      await fs.appendFile(file, 'line one\n');

      expect(await fs.readFileText(file)).toBe('line one\n');
    });

    it('appends to an existing file', async () => {
      const fs = createLocalFsAdapter();
      const file = join(dir, 'log.jsonl');

      await fs.writeFile(file, 'a\n');
      await fs.appendFile(file, 'b\n');
      await fs.appendFile(file, 'c\n');

      expect(await fs.readFileText(file)).toBe('a\nb\nc\n');
    });

    it('produces no interleaved writes under concurrent appenders (O_APPEND atomicity)', async () => {
      const fs = createLocalFsAdapter();
      const file = join(dir, 'concurrent.jsonl');

      // Each write is well under PIPE_BUF (4 KiB on macOS/Linux).
      const N = 200;
      const writers = Array.from(
        {
          length: N,
        },
        (_, i) => {
          const id = String(i).padStart(3, '0');
          return fs.appendFile(file, `${id}\n`);
        },
      );

      await Promise.all(writers);

      const raw = await readFile(file, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.length > 0);

      expect(lines.length).toBe(N);
      // Every line is exactly 3 ASCII digits — no torn writes, no merged lines.
      for (const line of lines) {
        expect(line).toMatch(/^\d{3}$/);
      }
      // Set of ids matches what we wrote.
      const ids = new Set(lines);
      expect(ids.size).toBe(N);
    });
  });

  describe('mkdir / access / stat / lstat / readdir', () => {
    it('creates nested directories', async () => {
      const fs = createLocalFsAdapter();
      const nested = join(dir, 'a', 'b', 'c');

      await fs.mkdir(nested);
      const s = await fs.stat(nested);

      expect(s.isDirectory()).toBe(true);
    });

    it('access throws ENOENT for missing path', async () => {
      const fs = createLocalFsAdapter();

      await expect(fs.access(join(dir, 'missing'))).rejects.toThrow();
    });

    it('stat returns file size', async () => {
      const fs = createLocalFsAdapter();
      const file = join(dir, 'sized.txt');
      await fs.writeFile(file, 'hello');

      const s = await fs.stat(file);

      expect(s.isFile()).toBe(true);
      expect(s.isDirectory()).toBe(false);
      expect(s.size).toBe(5);
    });

    it('readdir lists entries', async () => {
      const fs = createLocalFsAdapter();
      await fs.writeFile(join(dir, 'a.txt'), '');
      await fs.writeFile(join(dir, 'b.txt'), '');
      await fs.mkdir(join(dir, 'sub'));

      const entries = await fs.readdir(dir);

      expect(entries.sort()).toEqual([
        'a.txt',
        'b.txt',
        'sub',
      ]);
    });
  });
});
