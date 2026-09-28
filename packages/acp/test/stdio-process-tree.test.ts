import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdioAcpTransport } from '../src/stdio';

const fixture = fileURLToPath(new URL('./fixtures/stdio-process-tree.cjs', import.meta.url));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function awaitPid(path: string): Promise<number> {
  for (let i = 0; i < 80; i++) {
    if (existsSync(path)) {
      return Number(readFileSync(path, 'utf8'));
    }
    await pause(25);
  }
  throw new Error('child pid was not written');
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
        return true;
      }
    }
    await pause(25);
  }
  return false;
}

describe.skipIf(process.platform === 'win32')('stdio process-tree teardown', () => {
  test('close kills a TERM-resistant wrapper and child, releases pipes, and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-stdio-'));
    const pidFile = join(dir, 'child.pid');
    let pid: number | undefined;
    try {
      const transport = await stdioAcpTransport({
        agentId: 'tree',
        command: process.execPath,
        args: [
          fixture,
        ],
        env: {
          ACP_PID_FILE: pidFile,
        },
      })({
        cwd: dir,
      });
      pid = await awaitPid(pidFile);
      const start = Date.now();
      await transport.close();
      expect(Date.now() - start).toBeLessThan(3000);
      await transport.close();
      expect(await gone(pid)).toBe(true);
      await expect(transport.readable.getReader().read()).resolves.toEqual({
        done: true,
        value: undefined,
      });
    } finally {
      if (pid && !(await gone(pid))) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      rmSync(dir, {
        recursive: true,
        force: true,
      });
    }
  }, 10_000);

  test('abort kills the child tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-abort-'));
    const pidFile = join(dir, 'child.pid');
    const controller = new AbortController();
    let pid: number | undefined;
    try {
      const transport = await stdioAcpTransport({
        agentId: 'tree',
        command: process.execPath,
        args: [
          fixture,
        ],
        env: {
          ACP_PID_FILE: pidFile,
        },
      })({
        cwd: dir,
        signal: controller.signal,
      });
      pid = await awaitPid(pidFile);
      controller.abort();
      await transport.close();
      expect(await gone(pid)).toBe(true);
    } finally {
      if (pid && !(await gone(pid))) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      rmSync(dir, {
        recursive: true,
        force: true,
      });
    }
  }, 10_000);
});

test('pre-abort never launches and a missing binary closes with a scoped error', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    stdioAcpTransport({
      agentId: 'stopped',
      command: process.execPath,
    })({
      cwd: tmpdir(),
      signal: controller.signal,
    }),
  ).rejects.toThrow('cancelled before launch');
  const transport = await stdioAcpTransport({
    agentId: 'missing',
    command: `missing-acp-${Date.now()}`,
  })({
    cwd: tmpdir(),
  });
  await pause(25);
  await expect(transport.close()).rejects.toThrow('failed to start');
});
