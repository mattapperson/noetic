import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLocalFsAdapter } from '@noetic/core';
import { createEmulatedShellAdapter } from '../../src/adapters/emulated-shell-adapter.js';

describe('createEmulatedShellAdapter', () => {
  let tempDir: string;
  const localFs = createLocalFsAdapter();

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'noetic-emulated-shell-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
    });
  });

  it('executes a simple echo command', async () => {
    const shell = createEmulatedShellAdapter({
      fs: localFs,
      cwd: tempDir,
    });

    const result = await shell.exec('echo hello', {
      cwd: tempDir,
    });

    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('returns non-zero exit code on failure', async () => {
    const shell = createEmulatedShellAdapter({
      fs: localFs,
      cwd: tempDir,
    });

    const result = await shell.exec('exit 42', {
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(42);
  });

  it('reads files written via FsAdapter', async () => {
    await localFs.writeFile(path.join(tempDir, 'test.txt'), 'fs-adapter-content');

    const shell = createEmulatedShellAdapter({
      fs: localFs,
      cwd: tempDir,
    });

    const result = await shell.exec(`cat ${path.join(tempDir, 'test.txt')}`, {
      cwd: tempDir,
    });

    expect(result.stdout.trim()).toBe('fs-adapter-content');
    expect(result.exitCode).toBe(0);
  });

  it('invokes onData callback with output', async () => {
    const shell = createEmulatedShellAdapter({
      fs: localFs,
      cwd: tempDir,
    });

    const chunks: Buffer[] = [];
    const result = await shell.exec('echo streamed', {
      cwd: tempDir,
      onData: (data) => {
        chunks.push(data);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(chunks.length).toBeGreaterThan(0);
    const combined = Buffer.concat(chunks).toString('utf-8');
    expect(combined).toContain('streamed');
  });

  it('supports piped commands', async () => {
    const shell = createEmulatedShellAdapter({
      fs: localFs,
      cwd: tempDir,
    });

    const result = await shell.exec('echo "hello world" | wc -w', {
      cwd: tempDir,
    });

    expect(result.stdout.trim()).toBe('2');
    expect(result.exitCode).toBe(0);
  });
});
