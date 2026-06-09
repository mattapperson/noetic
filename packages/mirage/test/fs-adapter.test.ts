import { describe, expect, it } from 'bun:test';
import { isMirageError, MirageError } from '../src/errors';
import { createMirageFsAdapter } from '../src/fs-adapter';
import type { MirageExecuteOptions, MirageExecuteResult, MirageWorkspace } from '../src/types';
import { createStubWorkspace } from './_stub-workspace';

describe('createMirageFsAdapter', () => {
  describe('readFile', () => {
    it('returns the bytes at the path', async () => {
      const ws = createStubWorkspace({
        files: {
          '/data.txt': 'hello',
        },
      });
      const fs = createMirageFsAdapter(ws);
      const buf = await fs.readFile('/data.txt');
      expect(buf.toString('utf-8')).toBe('hello');
    });

    it('detaches from workspace-owned buffers across successive reads', async () => {
      // Simulate a pooling workspace: every `execute` returns the SAME
      // underlying `Uint8Array`, overwriting its contents per call. If
      // `readFile` aliased that buffer, the Buffer from the first read
      // would mutate when the second read arrives.
      //
      // `Buffer.from(Uint8Array)` already copies on current Node / Bun,
      // so this test would pass without the explicit `.slice()` in the
      // adapter. We keep the test to lock in the invariant: the
      // Buffer returned from read N MUST be unaffected by read N+1,
      // regardless of the underlying Node/Bun/exotic-runtime Buffer
      // semantics.
      let callCount = 0;
      const pool = new Uint8Array(5);
      const ws: MirageWorkspace = {
        async execute(): Promise<MirageExecuteResult> {
          callCount += 1;
          // First call: "hello". Second call: "world".
          const payload =
            callCount === 1 ? new TextEncoder().encode('hello') : new TextEncoder().encode('world');
          pool.set(payload);
          return {
            stdout: pool.subarray(0, payload.length),
            stderr: new Uint8Array(0),
            exitCode: 0,
          };
        },
      };
      const fs = createMirageFsAdapter(ws);
      const first = await fs.readFile('/a');
      expect(first.toString('utf-8')).toBe('hello');
      const second = await fs.readFile('/b');
      expect(second.toString('utf-8')).toBe('world');
      // The kicker: even after the pool has been overwritten, the
      // Buffer returned from the first read MUST still read "hello".
      expect(first.toString('utf-8')).toBe('hello');
      expect(callCount).toBe(2);
    });
  });

  describe('readFileText', () => {
    it('decodes UTF-8', async () => {
      const ws = createStubWorkspace({
        files: {
          '/u.txt': 'café',
        },
      });
      const fs = createMirageFsAdapter(ws);
      expect(await fs.readFileText('/u.txt')).toBe('café');
    });
  });

  describe('writeFile', () => {
    it('writes UTF-8 content through stdin', async () => {
      const ws = createStubWorkspace();
      const fs = createMirageFsAdapter(ws);
      await fs.writeFile('/out.txt', 'hello world');
      expect(new TextDecoder().decode(ws.peek('/out.txt'))).toBe('hello world');
    });

    it('overwrites existing content', async () => {
      const ws = createStubWorkspace({
        files: {
          '/out.txt': 'old',
        },
      });
      const fs = createMirageFsAdapter(ws);
      await fs.writeFile('/out.txt', 'new');
      expect(new TextDecoder().decode(ws.peek('/out.txt'))).toBe('new');
    });
  });

  describe('writeFileBytes', () => {
    it('round-trips arbitrary bytes via base64', async () => {
      const ws = createStubWorkspace();
      const fs = createMirageFsAdapter(ws);
      // Payload intentionally includes bytes that are NOT valid UTF-8:
      // 0xff, 0xfe, a raw 0x00 NUL, and 0x80 (continuation without lead).
      const payload = new Uint8Array([
        0x00,
        0x01,
        0x80,
        0xff,
        0xfe,
        0x7f,
        0x42,
      ]);
      await fs.writeFileBytes('/bin.dat', Buffer.from(payload));
      const stored = ws.peek('/bin.dat');
      expect(stored.length).toBe(payload.length);
      for (let i = 0; i < payload.length; i += 1) {
        expect(stored[i]).toBe(payload[i]);
      }
    });
  });

  describe('appendFile', () => {
    it('appends to an existing file', async () => {
      const ws = createStubWorkspace({
        files: {
          '/log.txt': 'one\n',
        },
      });
      const fs = createMirageFsAdapter(ws);
      await fs.appendFile('/log.txt', 'two\n');
      expect(new TextDecoder().decode(ws.peek('/log.txt'))).toBe('one\ntwo\n');
    });

    it('creates the file when it does not exist', async () => {
      const ws = createStubWorkspace();
      const fs = createMirageFsAdapter(ws);
      await fs.appendFile('/new.txt', 'first\n');
      expect(new TextDecoder().decode(ws.peek('/new.txt'))).toBe('first\n');
    });
  });

  describe('mkdir', () => {
    it('creates a directory', async () => {
      const ws = createStubWorkspace();
      const fs = createMirageFsAdapter(ws);
      await fs.mkdir('/new/dir');
      expect(ws.has('/new/dir')).toBe(true);
    });

    it('is idempotent (mkdir -p)', async () => {
      const ws = createStubWorkspace();
      const fs = createMirageFsAdapter(ws);
      await fs.mkdir('/d');
      await fs.mkdir('/d');
      expect(ws.has('/d')).toBe(true);
    });
  });

  describe('rename', () => {
    it('moves a file', async () => {
      const ws = createStubWorkspace({
        files: {
          '/a.txt': 'hello',
        },
      });
      const fs = createMirageFsAdapter(ws);
      await fs.rename('/a.txt', '/b.txt');
      expect(ws.has('/a.txt')).toBe(false);
      expect(new TextDecoder().decode(ws.peek('/b.txt'))).toBe('hello');
    });
  });

  describe('rm', () => {
    it('removes a file', async () => {
      const ws = createStubWorkspace({
        files: {
          '/doomed.txt': 'x',
        },
      });
      const fs = createMirageFsAdapter(ws);
      await fs.rm('/doomed.txt');
      expect(ws.has('/doomed.txt')).toBe(false);
    });

    it('recursive: true removes a non-empty directory', async () => {
      const ws = createStubWorkspace({
        files: {
          '/d/a.txt': 'a',
          '/d/b.txt': 'b',
        },
      });
      const fs = createMirageFsAdapter(ws);
      await fs.rm('/d', {
        recursive: true,
      });
      expect(ws.has('/d')).toBe(false);
    });

    it('force: true swallows ENOENT', async () => {
      const ws = createStubWorkspace();
      const fs = createMirageFsAdapter(ws);
      await fs.rm('/missing', {
        force: true,
      });
      // No throw = pass.
    });

    it('throws when the path is missing and force is not set', async () => {
      const ws = createStubWorkspace();
      const fs = createMirageFsAdapter(ws);
      await expect(fs.rm('/missing')).rejects.toThrow();
    });
  });

  describe('access', () => {
    it('resolves when the path exists', async () => {
      const ws = createStubWorkspace({
        files: {
          '/x.txt': '',
        },
      });
      const fs = createMirageFsAdapter(ws);
      await fs.access('/x.txt');
    });

    it('throws when the path is missing', async () => {
      const ws = createStubWorkspace();
      const fs = createMirageFsAdapter(ws);
      await expect(fs.access('/nope')).rejects.toThrow();
    });
  });

  describe('stat', () => {
    it('reports regular file', async () => {
      const ws = createStubWorkspace({
        files: {
          '/x.txt': 'hello',
        },
      });
      const fs = createMirageFsAdapter(ws);
      const s = await fs.stat('/x.txt');
      expect(s.isFile()).toBe(true);
      expect(s.isDirectory()).toBe(false);
      expect(s.isSymbolicLink()).toBe(false);
      expect(s.size).toBe(5);
    });

    it('reports regular empty file', async () => {
      const ws = createStubWorkspace({
        files: {
          '/empty.txt': '',
        },
      });
      const fs = createMirageFsAdapter(ws);
      const s = await fs.stat('/empty.txt');
      expect(s.isFile()).toBe(true);
      expect(s.size).toBe(0);
    });

    it('reports directories', async () => {
      const ws = createStubWorkspace();
      const fs = createMirageFsAdapter(ws);
      await fs.mkdir('/d');
      const s = await fs.stat('/d');
      expect(s.isDirectory()).toBe(true);
      expect(s.isFile()).toBe(false);
    });
  });

  describe('readdir', () => {
    it('lists directory entries', async () => {
      const ws = createStubWorkspace({
        files: {
          '/d/a.txt': '',
          '/d/b.txt': '',
          '/d/c.txt': '',
        },
      });
      const fs = createMirageFsAdapter(ws);
      const entries = await fs.readdir('/d');
      expect(entries.sort()).toEqual([
        'a.txt',
        'b.txt',
        'c.txt',
      ]);
    });

    it('returns empty array for empty directory', async () => {
      const ws = createStubWorkspace();
      const fs = createMirageFsAdapter(ws);
      await fs.mkdir('/empty');
      expect(await fs.readdir('/empty')).toEqual([]);
    });
  });

  describe('error shape', () => {
    it('surfaces MirageError with kind "io_failed" on generic failures', async () => {
      const ws = createStubWorkspace();
      const fs = createMirageFsAdapter(ws);
      try {
        await fs.readFile('/missing');
        throw new Error('expected throw');
      } catch (err) {
        expect(isMirageError(err)).toBe(true);
        if (err instanceof MirageError) {
          expect(err.kind).toBe('io_failed');
          expect(err.operation).toBe('readFile');
          expect(err.path).toBe('/missing');
          expect(err.stderr).toContain('no such file');
        }
      }
    });

    it('surfaces MirageError with kind "resource_op_unsupported" on exit 127', async () => {
      // Build a workspace that always returns exit 127 / "command not found".
      const ws: MirageWorkspace = {
        async execute(_cmd: string, _options?: MirageExecuteOptions): Promise<MirageExecuteResult> {
          return {
            stdout: new Uint8Array(0),
            stderr: new TextEncoder().encode('bash: stat: command not found'),
            exitCode: 127,
          };
        },
      };
      const fs = createMirageFsAdapter(ws);
      try {
        await fs.stat('/x');
        throw new Error('expected throw');
      } catch (err) {
        expect(isMirageError(err)).toBe(true);
        if (err instanceof MirageError) {
          expect(err.kind).toBe('resource_op_unsupported');
          expect(err.operation).toBe('stat');
          expect(err.exitCode).toBe(127);
        }
      }
    });

    it('surfaces "resource_op_unsupported" when stderr says "not implemented"', async () => {
      const ws: MirageWorkspace = {
        async execute(): Promise<MirageExecuteResult> {
          return {
            stdout: new Uint8Array(0),
            stderr: new TextEncoder().encode('not implemented: mkdir on /s3 handler'),
            exitCode: 1,
          };
        },
      };
      const fs = createMirageFsAdapter(ws);
      try {
        await fs.mkdir('/s3/new-dir');
        throw new Error('expected throw');
      } catch (err) {
        expect(isMirageError(err)).toBe(true);
        if (err instanceof MirageError) {
          expect(err.kind).toBe('resource_op_unsupported');
        }
      }
    });

    it('does NOT classify legitimate "not supported" I/O errors as unsupported', async () => {
      // Regression for false-positive heuristic: chmod-on-FAT, NFS
      // operation-not-supported, and read-only-filesystem errors all
      // include "not supported" in their stderr but represent real
      // io_failed conditions — the op IS implemented, the backend is
      // refusing this specific call.
      const falsePositiveStderrs = [
        'chmod: not supported on this filesystem',
        'nfs: operation not supported by server',
        'file system is read-only, not supported write',
      ];
      for (const stderr of falsePositiveStderrs) {
        const ws: MirageWorkspace = {
          async execute(): Promise<MirageExecuteResult> {
            return {
              stdout: new Uint8Array(0),
              stderr: new TextEncoder().encode(stderr),
              exitCode: 1,
            };
          },
        };
        const fs = createMirageFsAdapter(ws);
        try {
          await fs.writeFile('/x', 'y');
          throw new Error(`expected throw for: ${stderr}`);
        } catch (err) {
          expect(isMirageError(err)).toBe(true);
          if (err instanceof MirageError) {
            expect(err.kind).toBe('io_failed');
          }
        }
      }
    });
  });

  describe('shell injection', () => {
    it('handles filenames containing single quotes', async () => {
      const ws = createStubWorkspace({
        files: {
          "/it's.txt": 'content',
        },
      });
      const fs = createMirageFsAdapter(ws);
      expect(await fs.readFileText("/it's.txt")).toBe('content');
    });

    it('handles filenames with $() and backticks (treated as literal)', async () => {
      // Literal `/` chars are directory separators in any POSIX
      // filesystem, so the injection payload stays within a single
      // path segment. shellQuote's airtight escaping is covered
      // exhaustively in path.test.ts.
      const sneaky = '/$(rm -rf .)_and_`echo pwn`.txt';
      const ws = createStubWorkspace();
      const fs = createMirageFsAdapter(ws);
      await fs.writeFile(sneaky, 'safe');
      expect(await fs.readFileText(sneaky)).toBe('safe');
    });

    it('handles filenames with embedded newlines', async () => {
      const nl = '/line1\nline2.txt';
      const ws = createStubWorkspace();
      const fs = createMirageFsAdapter(ws);
      await fs.writeFile(nl, 'ok');
      expect(await fs.readFileText(nl)).toBe('ok');
    });
  });
});
