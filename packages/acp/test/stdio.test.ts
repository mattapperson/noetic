/**
 * The stdio transport's process lifetime (#97): closing or aborting stops the
 * agent's whole process tree — a wrapper's grandchild included — and releases
 * the pipes, deterministically and without an authenticated provider.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AcpTransport } from '@noetic-tools/types';
import { isAcpConnectError } from '@noetic-tools/types';
import { localMachine, stdioAcpTransport, stopProcessTree } from '../src/stdio';

const FIXTURE = fileURLToPath(new URL('./fixtures/stdio-tree.ts', import.meta.url));
const POSIX = process.platform !== 'win32';

/** Launch the wrapper/child fixture and read both pids off its stdout. */
async function launchTree(
  mode: 'stubborn' | 'cooperative',
  signal?: AbortSignal,
): Promise<{
  transport: AcpTransport;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  pids: number[];
}> {
  const transport = await stdioAcpTransport({
    agentId: 'tree',
    command: process.execPath,
    args: [
      FIXTURE,
      mode,
    ],
  })({
    cwd: tmpdir(),
    signal,
  });
  const reader = transport.readable.getReader();
  const decoder = new TextDecoder();
  let output = '';
  while (output.trim().split('\n').length < 2) {
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error('The fixture closed before reporting its child.');
    }
    output += decoder.decode(chunk.value);
  }
  return {
    transport,
    reader,
    pids: output.trim().split('\n').map(Number),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectStopped(pids: number[]): Promise<void> {
  const deadline = Date.now() + 3e3;
  while (pids.some(alive) && Date.now() < deadline) {
    await Bun.sleep(20);
  }
  expect(pids.filter(alive)).toEqual([]);
}

describe.skipIf(!POSIX)('stdio transport lifetime', () => {
  it('close() stops a wrapper and its grandchild, closes the pipes, and is idempotent', async () => {
    const { transport, reader, pids } = await launchTree('cooperative');
    expect(pids).toHaveLength(2);
    expect(pids.every(alive)).toBe(true);
    const pending = reader.read();

    const first = transport.close();
    expect(transport.close()).toBe(first);
    await first;

    // The read the agent's stream had pending finishes: the pipe is released.
    const settled = await pending.then(
      (chunk) => chunk.done,
      () => true,
    );
    expect(settled).toBe(true);
    await expectStopped(pids);
    await transport.close();
  });

  it('escalates to SIGKILL for a grandchild that ignores SIGTERM', async () => {
    const { transport, pids } = await launchTree('stubborn');
    const started = Date.now();
    await transport.close();
    await expectStopped(pids);
    // Bounded: the grace period plus the kill wait, never a hang.
    expect(Date.now() - started).toBeLessThan(5e3);
  }, 10e3);

  it('aborting the signal stops the tree', async () => {
    const controller = new AbortController();
    const { transport, pids } = await launchTree('cooperative', controller.signal);
    controller.abort();
    await expectStopped(pids);
    await transport.close();
  });

  it('localMachine().close() stops every tree it launched', async () => {
    // Direct children: the keeper's own shutdown is covered in keeper.test.ts.
    const machine = await localMachine('tree', {
      keeper: false,
    })({});
    const transport = await machine.launch({
      command: process.execPath,
      args: [
        FIXTURE,
        'cooperative',
      ],
      cwd: tmpdir(),
    });
    const reader = transport.readable.getReader();
    let output = '';
    while (output.trim().split('\n').length < 2) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      output += new TextDecoder().decode(chunk.value);
    }
    const pids = output.trim().split('\n').map(Number);
    await machine.close();
    await expectStopped(pids);
  });
});

describe('stdio transport start failures', () => {
  it('rejects a missing binary at start with AcpConnectError', async () => {
    const error = await stdioAcpTransport({
      agentId: 'missing',
      command: '/definitely/not/an/acp/agent',
    })({
      cwd: tmpdir(),
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAcpConnectError(error)).toBe(true);
    expect(String(error)).toContain('failed to start');
  });

  it('refuses to launch when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const error = await stdioAcpTransport({
      agentId: 'aborted',
      command: process.execPath,
      args: [
        FIXTURE,
      ],
    })({
      cwd: tmpdir(),
      signal: controller.signal,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAcpConnectError(error)).toBe(true);
    expect(String(error)).toContain('already aborted');
  });
});

describe.skipIf(!POSIX)('stdio transport aborted while starting', () => {
  it('rejects and stops the process when the signal aborts before it has started', async () => {
    const controller = new AbortController();
    const opening = stdioAcpTransport({
      agentId: 'racing',
      command: process.execPath,
      args: [
        FIXTURE,
        'stubborn',
      ],
    })({
      cwd: tmpdir(),
      signal: controller.signal,
    });
    // spawn() has run; its 'spawn' event has not been seen yet.
    controller.abort(new Error('stop'));

    const error = await opening.then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isAcpConnectError(error)).toBe(true);
    expect(String(error)).toContain('aborted while starting');
  }, 10e3);
});

describe.skipIf(!POSIX)('stopProcessTree', () => {
  it('returns at once for a child that has already exited', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        '0',
      ],
      {
        detached: true,
        stdio: [
          'pipe',
          'pipe',
          'ignore',
        ],
      },
    );
    await new Promise((resolve) => child.once('exit', resolve));
    const started = Date.now();
    await stopProcessTree(child);
    expect(Date.now() - started).toBeLessThan(1e3);
  });

  it('honours a shorter grace period before SIGKILL', async () => {
    const child = spawn(
      process.execPath,
      [
        FIXTURE,
        'stubborn',
      ],
      {
        detached: true,
        stdio: [
          'pipe',
          'pipe',
          'ignore',
        ],
      },
    );
    let output = '';
    for await (const chunk of child.stdout) {
      output += String(chunk);
      if (output.trim().split('\n').length >= 2) {
        break;
      }
    }
    const pids = output.trim().split('\n').map(Number);
    const started = Date.now();
    await stopProcessTree(child, {
      graceMs: 50,
    });
    await expectStopped(pids);
    expect(Date.now() - started).toBeLessThan(1.5e3);
  });
});

describe.skipIf(!POSIX)('stopProcessTree edge cases', () => {
  it('stops cleanly when the leader exited but is not yet reaped (EPERM)', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        '0',
      ],
      {
        detached: true,
        stdio: [
          'pipe',
          'pipe',
          'ignore',
        ],
      },
    );
    await new Promise((resolve) => child.once('spawn', resolve));
    // Block the event loop so the exited leader stays unreaped.
    const until = Date.now() + 500;
    while (Date.now() < until) {
      // busy wait
    }
    await stopProcessTree(child, {
      graceMs: 50,
    });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('stops a child that was not started as a group leader', async () => {
    const child = spawn(
      process.execPath,
      [
        FIXTURE,
        'child',
        'stubborn',
      ],
      {
        stdio: [
          'pipe',
          'pipe',
          'ignore',
        ],
      },
    );
    await new Promise((resolve) => child.once('spawn', resolve));
    const pid = child.pid;
    assert(pid);
    await stopProcessTree(child, {
      graceMs: 50,
    });
    await expectStopped([
      pid,
    ]);
  });
});

describe.skipIf(!POSIX)('a host that exits without closing its agent', () => {
  const host = fileURLToPath(new URL('./fixtures/exit-host.ts', import.meta.url));

  async function pidsLeftBy(whenHostExits: 'keep' | 'stop'): Promise<number[]> {
    const child = spawn(
      process.execPath,
      [
        host,
        whenHostExits,
      ],
      {
        stdio: [
          'ignore',
          'pipe',
          'inherit',
        ],
      },
    );
    let output = '';
    for await (const chunk of child.stdout) {
      output += String(chunk);
    }
    const pids = JSON.parse(output);
    assert(Array.isArray(pids));
    return pids.map(Number);
  }

  it("kills the agent's group on exit under whenHostExits: 'stop'", async () => {
    const pids = await pidsLeftBy('stop');
    expect(pids).toHaveLength(2);
    await expectStopped(pids);
  });

  it("leaves it running under 'keep'", async () => {
    const pids = await pidsLeftBy('keep');
    try {
      await Bun.sleep(200);
      expect(pids.some(alive)).toBe(true);
    } finally {
      try {
        process.kill(-(pids[0] ?? 0), 'SIGKILL');
      } catch {
        // Already gone.
      }
      await expectStopped(pids);
    }
  });
});
