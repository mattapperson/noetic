import { describe, expect, it } from 'bun:test';
import { createLocalShellAdapter } from '../../src/adapters/local-shell-adapter';

describe('createLocalShellAdapter', () => {
  const shell = createLocalShellAdapter();

  it('executes a simple echo command', async () => {
    const result = await shell.exec('echo hello', {
      cwd: process.cwd(),
    });

    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('captures stderr separately from stdout', async () => {
    const result = await shell.exec('echo out; echo err >&2', {
      cwd: process.cwd(),
    });

    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
    expect(result.exitCode).toBe(0);
  });

  it('returns non-zero exit code on failure', async () => {
    const result = await shell.exec('exit 42', {
      cwd: process.cwd(),
    });

    expect(result.exitCode).toBe(42);
  });

  it('respects the cwd option', async () => {
    const result = await shell.exec('pwd', {
      cwd: '/tmp',
    });

    expect(result.stdout.trim()).toMatch(/^\/.*tmp/);
    expect(result.exitCode).toBe(0);
  });

  it('invokes onData callback with output chunks', async () => {
    const chunks: Buffer[] = [];
    const result = await shell.exec('echo streamed', {
      cwd: process.cwd(),
      onData: (data) => {
        chunks.push(data);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(chunks.length).toBeGreaterThan(0);
    const combined = Buffer.concat(chunks).toString('utf-8');
    expect(combined).toContain('streamed');
  });

  it('merges env variables with process env', async () => {
    const result = await shell.exec('echo $NOETIC_TEST_VAR', {
      cwd: process.cwd(),
      env: {
        NOETIC_TEST_VAR: 'adapter-works',
      },
    });

    expect(result.stdout.trim()).toBe('adapter-works');
  });
});
