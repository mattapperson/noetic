/**
 * An agent run by its keeper outlives a host that dies mid-turn, and a new
 * host reattaches: it gets the whole turn's updates, the request the agent was
 * still waiting on, and the turn's result — real processes throughout.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AcpClientHost, AcpReattachHandle, AcpSessionNotification } from '@noetic-tools/types';
import { isAcpConnectError } from '@noetic-tools/types';
import { customAcpAgent } from '../src/agents';
import { LineSplitter } from '../src/keeper/protocol';
import { MemoryFs, RecordingShell } from './_helpers';

const POSIX = process.platform !== 'win32';
const HOST = fileURLToPath(new URL('./fixtures/keeper-host.ts', import.meta.url));
const AGENT = fileURLToPath(new URL('./fixtures/keeper-agent.ts', import.meta.url));

const agent = customAcpAgent({
  agentId: 'kept',
  command: process.execPath,
  args: [
    AGENT,
  ],
});

interface Started {
  host: ChildProcess;
  handle: AcpReattachHandle;
  sessionId: string;
}

/** Start a first host in its own process; resolves once the agent has spoken. */
async function firstHost(whenHostExits: 'keep' | 'stop', prompt: string): Promise<Started> {
  const host = spawn(
    process.execPath,
    [
      HOST,
      whenHostExits,
      prompt,
    ],
    {
      stdio: [
        'ignore',
        'pipe',
        'inherit',
      ],
    },
  );
  const splitter = new LineSplitter();
  const line = await new Promise<string>((resolve, reject) => {
    host.stdout?.on('data', (chunk: Buffer) => {
      const [first] = splitter.push(chunk);
      if (first !== undefined) {
        resolve(first);
      }
    });
    host.once('exit', () => reject(new Error('The first host exited early.')));
  });
  const parsed: {
    handle?: AcpReattachHandle;
    sessionId?: string;
  } = JSON.parse(line);
  assert(parsed.handle && parsed.sessionId);
  return {
    host,
    handle: parsed.handle,
    sessionId: parsed.sessionId,
  };
}

/** Kill a host the way a crash does: no chance to close anything. */
async function crash(host: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => host.once('exit', resolve));
  host.kill('SIGKILL');
  await exited;
}

function secondHost(updates: AcpSessionNotification[]): AcpClientHost {
  return {
    cwd: process.cwd(),
    threadId: 'second-host',
    fs: new MemoryFs(),
    shell: new RecordingShell(),
    permissions: {
      default: 'allow',
    },
    onSessionUpdate: (notification) => {
      updates.push(notification);
    },
  };
}

function texts(updates: AcpSessionNotification[]): string {
  return updates
    .map((n) =>
      n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text'
        ? n.update.content.text
        : '',
    )
    .join('');
}

describe.skipIf(!POSIX)('a kept agent and a host that dies', () => {
  it('reattaches: the whole turn, the waiting permission request, and the result', async () => {
    const { host, handle, sessionId } = await firstHost('keep', 'ask');
    await crash(host);

    const updates: AcpSessionNotification[] = [];
    const connection = await agent.connect({
      host: secondHost(updates),
      reattach: handle,
    });
    try {
      assert(connection.attachSession);
      const session = await connection.attachSession(sessionId);
      // What the agent advertised when the first host opened the session.
      expect(session.modes?.currentModeId).toBe('auto');
      assert(session.resumeTurn);
      const result = await session.resumeTurn({});

      assert(result);
      expect(result.stopReason).toBe('end_turn');
      // "one " was sent to the first host before it died; the permission
      // request it never answered was asked again here and allowed.
      expect(result.text).toBe('one two');
      expect(texts(updates)).toBe('one two');
      // The same live session takes a follow-up mode and turn.
      await session.setMode('read-only');
      const next = await session.prompt({
        content: [
          {
            type: 'text',
            text: 'slow',
          },
        ],
      });
      expect(next.text).toBe('one two');
    } finally {
      await connection.close();
    }
    // Closing stops the keeper and its agent: there is nothing left to attach to.
    const gone = await agent
      .connect({
        host: secondHost([]),
        reattach: handle,
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isAcpConnectError(gone)).toBe(true);
  }, 30e3);

  it('hands over a turn that finished while no host was attached', async () => {
    const { host, handle, sessionId } = await firstHost('keep', 'slow');
    await crash(host);
    // Let the agent finish its turn with no host attached.
    await Bun.sleep(1e3);

    const updates: AcpSessionNotification[] = [];
    const connection = await agent.connect({
      host: secondHost(updates),
      reattach: handle,
    });
    try {
      assert(connection.attachSession);
      const session = await connection.attachSession(sessionId);
      assert(session.resumeTurn);
      const result = await session.resumeTurn({});
      assert(result);
      expect(result.text).toBe('one two');
      // Nothing is running now: a second resume finds no turn.
      expect(await session.resumeTurn({})).toBeUndefined();
    } finally {
      await connection.close();
    }
  }, 30e3);

  it("stops the agent with its host under whenHostExits: 'stop'", async () => {
    const { host, handle } = await firstHost('stop', 'ask');
    await crash(host);
    await Bun.sleep(500);

    const error = await agent
      .connect({
        host: secondHost([]),
        reattach: handle,
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isAcpConnectError(error)).toBe(true);
  }, 30e3);

  it('refuses a session the agent does not have', async () => {
    const { host, handle } = await firstHost('keep', 'slow');
    await crash(host);
    const connection = await agent.connect({
      host: secondHost([]),
      reattach: handle,
    });
    try {
      assert(connection.attachSession);
      const error = await connection.attachSession('no-such-session').then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isAcpConnectError(error)).toBe(true);
    } finally {
      await connection.close();
    }
  }, 30e3);
});
