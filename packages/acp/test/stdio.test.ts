import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AcpConnectError } from '@noetic-tools/types';
import { stdioAcpTransport } from '../src/stdio';

const fixture = fileURLToPath(new URL('./fixtures/stdio-tree.ts', import.meta.url));
const node = spawnSync(
  'node',
  [
    '-p',
    'process.execPath',
  ],
  {
    encoding: 'utf8',
  },
).stdout.trim();

async function tree(signal?: AbortSignal) {
  const transport = await stdioAcpTransport({
    agentId: 'tree',
    command: node,
    args: [
      fixture,
    ],
  })({
    cwd: tmpdir(),
    signal,
  });
  const reader = transport.readable.getReader();
  let output = '';
  while (output.trim().split('\n').length < 2) {
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error('Fixture closed before reporting its child.');
    }
    output += new TextDecoder().decode(chunk.value);
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
  const deadline = Date.now() + 2_000;
  while (pids.some(alive) && Date.now() < deadline) {
    await Bun.sleep(20);
  }
  expect(pids.filter(alive)).toEqual([]);
}

describe('stdio lifetime', () => {
  it('closes inherited pipes and kills a stubborn grandchild, with shared close completion', async () => {
    const { transport, reader, pids } = await tree();
    try {
      const pending = reader.read().then(
        () => true,
        () => true,
      );
      const first = transport.close();
      expect(transport.close()).toBe(first);
      await first;
      expect(await pending).toBe(true);
      await expectStopped(pids);
    } finally {
      await transport.close();
      reader.releaseLock();
    }
  });

  it('aborts the whole group, even while its stdout is held by a grandchild', async () => {
    const abort = new AbortController();
    const { transport, reader, pids } = await tree(abort.signal);
    abort.abort();
    await transport.close();
    await expectStopped(pids);
    reader.releaseLock();
  });

  it('rejects an already aborted launch without spawning', async () => {
    const signal = AbortSignal.abort('stop');
    await expect(
      stdioAcpTransport({
        agentId: 'abort',
        command: node,
      })({
        cwd: tmpdir(),
        signal,
      }),
    ).rejects.toBeInstanceOf(AcpConnectError);
  });

  it('handles abort racing the spawn event', async () => {
    const abort = new AbortController();
    const opening = stdioAcpTransport({
      agentId: 'race',
      command: node,
      args: [
        '-e',
        'setInterval(() => {}, 1000)',
      ],
    })({
      cwd: tmpdir(),
      signal: abort.signal,
    });
    abort.abort();
    await expect(opening).rejects.toBeInstanceOf(AcpConnectError);
  });

  it('reports an invalid working directory at connection time', async () => {
    await expect(
      stdioAcpTransport({
        agentId: 'cwd',
        command: node,
      })({
        cwd: '/noetic-missing-directory',
      }),
    ).rejects.toBeInstanceOf(AcpConnectError);
  });

  it('reports a missing binary at connection time', async () => {
    await expect(
      stdioAcpTransport({
        agentId: 'missing',
        command: '/noetic-missing-binary',
      })({
        cwd: tmpdir(),
      }),
    ).rejects.toBeInstanceOf(AcpConnectError);
  });

  it('allows closing a child that exited on its own', async () => {
    const transport = await stdioAcpTransport({
      agentId: 'exit',
      command: node,
      args: [
        '-e',
        'process.exit(0)',
      ],
    })({
      cwd: tmpdir(),
    });
    const reader = transport.readable.getReader();
    expect((await reader.read()).done).toBe(true);
    await transport.close();
    reader.releaseLock();
  });
});
