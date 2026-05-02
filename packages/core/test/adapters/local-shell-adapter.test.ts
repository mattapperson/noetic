import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalShellAdapter } from '../../src/adapters/local-shell-adapter';

describe('createLocalShellAdapter', () => {
  const shell = createLocalShellAdapter({
    useRtk: false,
  });

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

  it('throws timeout:N when the timeout fires', async () => {
    const start = Date.now();
    try {
      await shell.exec('sleep 5', {
        cwd: process.cwd(),
        timeout: 0.1,
      });
      throw new Error('expected timeout to throw');
    } catch (err) {
      if (!(err instanceof Error)) {
        throw err;
      }
      expect(err.message).toBe('timeout:0.1');
    }
    // Should abort well under the 5s sleep.
    expect(Date.now() - start).toBeLessThan(2e3);
  });

  it('resolves normally (does not throw) on signal abort', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5e1);
    // Should not throw — callers track aborts via their own state.
    const result = await shell.exec('sleep 5', {
      cwd: process.cwd(),
      signal: controller.signal,
    });
    // Killed process; exit code is null or non-zero.
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });
});

/**
 * rtk wrapping tests use a fake `rtk` binary on a synthetic PATH so the
 * rewrite contract is exercised without depending on the host having rtk
 * installed (CI machines may not).
 *
 * Fake rtk behavior:
 *   `rtk rewrite "<cmd>"` exits 0 with `__rtk__ <cmd>` for commands containing
 *   the marker `RTK_REWRITES_THIS`, exits 1 silently otherwise. This mirrors
 *   the real binary's "exit 1 + no output → caller falls through" contract.
 */
describe('createLocalShellAdapter rtk wrapping', () => {
  let fakeBinDir: string;
  let originalPath: string | undefined;

  beforeAll(() => {
    fakeBinDir = mkdtempSync(join(tmpdir(), 'rtk-shim-'));
    const rtkScript = `#!/bin/sh
if [ "$1" = "rewrite" ]; then
  shift
  case "$*" in
    *RTK_REWRITES_THIS*) echo "echo rewritten"; exit 0 ;;
    *) exit 1 ;;
  esac
fi
exit 0
`;
    const rtkPath = join(fakeBinDir, 'rtk');
    writeFileSync(rtkPath, rtkScript, {
      mode: 0o755,
    });
    originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    rmSync(fakeBinDir, {
      recursive: true,
      force: true,
    });
  });

  it('reports rtkAvailable: false when useRtk is disabled', () => {
    const adapter = createLocalShellAdapter({
      useRtk: false,
    });
    expect(adapter.useRtk).toBe(false);
    expect(adapter.rtkAvailable).toBe(false);
    expect(adapter.rtkPath).toBeNull();
  });

  it('finds rtk on PATH when useRtk is enabled', () => {
    const adapter = createLocalShellAdapter({
      useRtk: true,
    });
    expect(adapter.useRtk).toBe(true);
    expect(adapter.rtkAvailable).toBe(true);
    expect(adapter.rtkPath).toBe(join(fakeBinDir, 'rtk'));
  });

  it('defaults useRtk to false when no options are passed', () => {
    const adapter = createLocalShellAdapter();
    expect(adapter.useRtk).toBe(false);
    expect(adapter.rtkAvailable).toBe(false);
  });

  it('reports rtkAvailable: false when rtk is not on PATH', () => {
    const savedPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const adapter = createLocalShellAdapter({
        useRtk: true,
      });
      expect(adapter.rtkAvailable).toBe(false);
      expect(adapter.rtkPath).toBeNull();
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('uses the rewritten command when rtk emits a rewrite (exit 0)', async () => {
    const adapter = createLocalShellAdapter({
      useRtk: true,
    });
    const result = await adapter.exec('echo RTK_REWRITES_THIS', {
      cwd: process.cwd(),
    });
    expect(result.stdout.trim()).toBe('rewritten');
    expect(result.exitCode).toBe(0);
  });

  it('falls through to the raw command when rtk has no rewrite (exit 1)', async () => {
    const adapter = createLocalShellAdapter({
      useRtk: true,
    });
    const result = await adapter.exec('echo no-rewrite-marker', {
      cwd: process.cwd(),
    });
    expect(result.stdout.trim()).toBe('no-rewrite-marker');
    expect(result.exitCode).toBe(0);
  });

  it('skips rtk entirely when useRtk is false even if rtk is on PATH', async () => {
    const adapter = createLocalShellAdapter({
      useRtk: false,
    });
    const result = await adapter.exec('echo RTK_REWRITES_THIS', {
      cwd: process.cwd(),
    });
    expect(result.stdout.trim()).toBe('RTK_REWRITES_THIS');
    expect(result.exitCode).toBe(0);
  });
});
