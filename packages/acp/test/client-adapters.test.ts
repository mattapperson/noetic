/**
 * Client-backed adapters, exercised over the real wire: the served agent's
 * `FsAdapter`/`ShellAdapter` calls travel as `fs/*` and `terminal/*` requests
 * to Noetic's own ACP client, which serves them from a MemoryFs and a
 * RecordingShell — the full inversion loop in one process.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { AcpAgentConnection } from '@noetic-tools/types';
import { frameworkCast, isAcpCapabilityError } from '@noetic-tools/types';
import { openAcpConnection } from '../src/connection';
import { toAcpAgent } from '../src/serve';
import type { AcpServeSessionInit } from '../src/serve-types';
import { loopbackTransport } from '../src/transport-loopback';
import { MemoryFs, RecordingShell } from './_helpers';

interface AdapterRig {
  connection: AcpAgentConnection;
  session: AcpServeSessionInit;
  fs: MemoryFs;
  shell: RecordingShell;
}

async function createAdapterRig(clientCapabilities?: {
  readTextFile?: boolean;
  writeTextFile?: boolean;
  terminal?: boolean;
}): Promise<AdapterRig> {
  const fs = new MemoryFs();
  const shell = new RecordingShell();
  let captured: AcpServeSessionInit | undefined;

  const transport = await loopbackTransport(
    toAcpAgent((session) => {
      captured = session;
      return {
        execute: () => Promise.resolve(),
        getFullStream: () => ({
          async *[Symbol.asyncIterator]() {},
        }),
        async *getItemStream() {},
        seedSessionHistory: () => undefined,
        abort: () => Promise.resolve(),
      };
    }),
  )({
    cwd: '/workspace',
  });

  const connection = await openAcpConnection({
    agentId: 'noetic-serve',
    transport,
    host: {
      cwd: '/workspace',
      fs,
      shell,
      threadId: 'client-thread',
      capabilities: clientCapabilities,
      onSessionUpdate: () => undefined,
    },
  });
  await connection.newSession({
    cwd: '/workspace',
  });
  assert(captured);
  return {
    connection,
    session: captured,
    fs,
    shell,
  };
}

describe('clientFsAdapter over the wire', () => {
  it('reads and writes through the client filesystem', async () => {
    const rig = await createAdapterRig();
    await rig.fs.writeFile('/workspace/notes.txt', 'from the editor');

    const text = await rig.session.client.fs.readFileText('/workspace/notes.txt');
    expect(text).toBe('from the editor');

    await rig.session.client.fs.writeFile('/workspace/out.txt', 'from the agent');
    expect(await rig.fs.readFileText('/workspace/out.txt')).toBe('from the agent');

    await rig.session.client.fs.appendFile('/workspace/out.txt', ' + more');
    expect(await rig.fs.readFileText('/workspace/out.txt')).toBe('from the agent + more');

    const buffer = await rig.session.client.fs.readFile('/workspace/out.txt');
    expect(buffer.toString('utf8')).toBe('from the agent + more');
    await rig.connection.close();
  });

  it('rejects operations the wire cannot express with AcpCapabilityError', async () => {
    const rig = await createAdapterRig();
    for (const call of [
      rig.session.client.fs.stat('/workspace/x'),
      rig.session.client.fs.readdir('/workspace'),
      rig.session.client.fs.rm('/workspace/x'),
      rig.session.client.fs.rename('/workspace/a', '/workspace/b'),
      rig.session.client.fs.writeFileBytes('/workspace/x', Buffer.from('a')),
    ]) {
      try {
        await call;
        expect.unreachable('wire-inexpressible op must reject');
      } catch (e) {
        assert(isAcpCapabilityError(e));
      }
    }
    // mkdir is a deliberate no-op: clients create parents on write.
    await rig.session.client.fs.mkdir('/workspace/dir');
    await rig.connection.close();
  });

  it('rejects with AcpCapabilityError when the client withdrew the capability', async () => {
    const rig = await createAdapterRig({
      readTextFile: false,
      writeTextFile: false,
      terminal: false,
    });
    try {
      await rig.session.client.fs.readFileText('/workspace/x');
      expect.unreachable('withdrawn readTextFile must reject');
    } catch (e) {
      assert(isAcpCapabilityError(e));
      expect(e.capability).toBe('fs.readTextFile');
    }
    try {
      await rig.session.client.shell.exec('echo-test', {
        cwd: '/workspace',
      });
      expect.unreachable('withdrawn terminal must reject');
    } catch (e) {
      assert(isAcpCapabilityError(e));
      expect(e.capability).toBe('terminal');
    }
    await rig.connection.close();
  });
});

describe('clientShellAdapter over the wire', () => {
  it('runs a command in a client terminal and returns its output', async () => {
    const rig = await createAdapterRig();
    rig.shell.script.set('/bin/sh -c echo-test', {
      stdout: 'hello from the editor terminal',
      exitCode: 0,
    });

    const result = await rig.session.client.shell.exec('echo-test', {
      cwd: '/workspace',
    });
    expect(result.stdout).toBe('hello from the editor terminal');
    expect(result.exitCode).toBe(0);

    const call = rig.shell.calls[0];
    assert(call);
    expect(call.command).toBe('/bin/sh -c echo-test');
    expect(call.options.cwd).toBe('/workspace');
    await rig.connection.close();
  });

  it('refuses stdin — the terminal wire has no representation for it', async () => {
    const rig = await createAdapterRig();
    try {
      await rig.session.client.shell.exec('cat', {
        cwd: '/workspace',
        stdin: 'piped',
      });
      expect.unreachable('stdin must reject');
    } catch (e) {
      assert(isAcpCapabilityError(e));
      expect(e.capability).toBe('terminal.stdin');
    }
    await rig.connection.close();
  });
});

describe('clientFsAdapter appendFile failure direction', () => {
  it('appends from empty when the file is genuinely missing', async () => {
    const rig = await createAdapterRig();
    await rig.session.client.fs.appendFile('/workspace/new.txt', 'first');
    expect(await rig.fs.readFileText('/workspace/new.txt')).toBe('first');
    await rig.connection.close();
  });

  it('propagates a non-missing read failure instead of truncating', async () => {
    const rig = await createAdapterRig();
    // Outside the session cwd: the CLIENT refuses the read (path confinement)
    // — an error that is not "file missing", so append must not write.
    try {
      await rig.session.client.fs.appendFile('/outside/secret.txt', 'clobber');
      expect.unreachable('confined read failure must propagate');
    } catch (e) {
      expect(e).toBeDefined();
    }
    expect(rig.fs.files.has('/outside/secret.txt')).toBe(false);
    await rig.connection.close();
  });
});

describe('clientShellAdapter timeout contract', () => {
  it('a timed-out command rejects with the TIMEOUT_ERROR_PREFIX message', async () => {
    const rig = await createAdapterRig();
    rig.shell.script.set('/bin/sh -c sleep-forever', {
      hold: new Promise(() => {}),
      stdout: '',
    });
    try {
      await rig.session.client.shell.exec('sleep-forever', {
        cwd: '/workspace',
        timeout: 0.05,
      });
      expect.unreachable('timeout must reject');
    } catch (e) {
      assert(e instanceof Error);
      expect(e.message.startsWith('timeout:')).toBe(true);
    }
    await rig.connection.close();
  });

  it('an already-aborted signal resolves empty without touching the wire', async () => {
    const rig = await createAdapterRig();
    const controller = new AbortController();
    controller.abort();
    const result = await rig.session.client.shell.exec('echo-test', {
      cwd: '/workspace',
      signal: controller.signal,
    });
    expect(result.exitCode).toBeNull();
    expect(rig.shell.calls).toHaveLength(0);
    await rig.connection.close();
  });
});

describe('clientShellAdapter unit surface (fake connection)', () => {
  interface FakeTerminalScript {
    output: string;
    exitCode: number | null;
    holdExit?: boolean;
  }

  function fakeConn(script: FakeTerminalScript): {
    conn: Parameters<typeof import('../src/client-adapters').clientShellAdapter>[0]['conn'];
    created: Array<Record<string, unknown>>;
    killed: () => boolean;
  } {
    const created: Array<Record<string, unknown>> = [];
    let killed = false;
    let releaseExit: (() => void) | undefined;
    const conn = frameworkCast<
      Parameters<typeof import('../src/client-adapters').clientShellAdapter>[0]['conn']
    >({
      createTerminal: async (params: Record<string, unknown>) => {
        created.push(params);
        return {
          id: 'term-1',
          currentOutput: async () => ({
            output: script.output,
            truncated: false,
          }),
          waitForExit: () =>
            script.holdExit && !killed
              ? new Promise((resolve) => {
                  releaseExit = () =>
                    resolve({
                      exitCode: null,
                    });
                })
              : Promise.resolve({
                  exitCode: script.exitCode,
                }),
          kill: async () => {
            killed = true;
            releaseExit?.();
          },
          release: async () => undefined,
        };
      },
    });
    return {
      conn,
      created,
      killed: () => killed,
    };
  }

  it('maps env, honors a custom shell, and feeds onData with the output', async () => {
    const { clientShellAdapter } = await import('../src/client-adapters');
    const fake = fakeConn({
      output: 'built ok',
      exitCode: 0,
    });
    const chunks: string[] = [];
    const shell = clientShellAdapter({
      conn: fake.conn,
      sessionId: 's1',
      capabilities: {
        terminal: true,
      },
      shell: [
        '/bin/bash',
        '-lc',
      ],
    });
    const result = await shell.exec('make build', {
      cwd: '/repo',
      env: {
        FOO: 'bar',
      },
      onData: (data) => {
        chunks.push(data.toString('utf8'));
      },
    });

    expect(result.stdout).toBe('built ok');
    expect(result.exitCode).toBe(0);
    const created = fake.created[0];
    assert(created);
    expect(created.command).toBe('/bin/bash');
    expect(created.args).toEqual([
      '-lc',
      'make build',
    ]);
    expect(created.env).toEqual([
      {
        name: 'FOO',
        value: 'bar',
      },
    ]);
    expect(chunks).toEqual([
      'built ok',
    ]);
  });

  it('a mid-flight signal abort kills the terminal and RESOLVES with the collected output', async () => {
    const { clientShellAdapter } = await import('../src/client-adapters');
    const fake = fakeConn({
      output: 'partial output',
      exitCode: null,
      holdExit: true,
    });
    const shell = clientShellAdapter({
      conn: fake.conn,
      sessionId: 's1',
      capabilities: {
        terminal: true,
      },
    });
    const controller = new AbortController();
    const running = shell.exec('sleep-forever', {
      cwd: '/repo',
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await running;
    expect(fake.killed()).toBe(true);
    expect(result.stdout).toBe('partial output');
    expect(result.exitCode).toBeNull();
  });
});

describe('toBytes without a Node Buffer global', () => {
  it('readFile falls back to TextEncoder bytes', async () => {
    const { clientFsAdapter } = await import('../src/client-adapters');
    const conn = frameworkCast<Parameters<typeof clientFsAdapter>[0]['conn']>({
      readTextFile: async () => ({
        content: 'héllo',
      }),
    });
    const fs = clientFsAdapter({
      conn,
      sessionId: 's1',
      capabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });
    const globalRecord = frameworkCast<Record<string, unknown>>(globalThis);
    const realBuffer = globalRecord.Buffer;
    globalRecord.Buffer = undefined;
    try {
      const bytes = await fs.readFile('/workspace/x');
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(bytes)).toBe('héllo');
    } finally {
      globalRecord.Buffer = realBuffer;
    }
  });
});
