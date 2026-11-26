// The runner adapters over stand-in sockets: one a Durable Object accepted, one
// a Worker's `fetch` upgrade opened. A scripted runner answers on the far end.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { HostFrame, RunnerFrame, WebSocketLike } from '@noetic-tools/core';
import {
  HostFrameSchema,
  isAcpConnectError,
  isNoeticConfigError,
  RunnerFrameSchema,
} from '@noetic-tools/core';
import type { UpgradedSocketLike, UpgradeFetchLike } from '../src/runner-subprocess';
import {
  createFetchSubprocessAdapter,
  createSocketSubprocessAdapter,
} from '../src/runner-subprocess';

//#region Stand-ins

interface FarEnd {
  /** Every frame the host sent, checked as a runner checks it. */
  readonly received: HostFrame[];
  readonly closed: () => boolean;
}

type Listener = (event: { data: unknown; error?: unknown }) => void;

/**
 * A socket whose far end is a runner that starts every command, prints
 * `ran <command>` and exits 0. It delivers nothing until accepted, as a
 * Worker's socket does.
 */
function runnerSocket(): {
  socket: UpgradedSocketLike;
  far: FarEnd;
} {
  const listeners = new Map<string, Listener[]>();
  const received: HostFrame[] = [];
  let accepted = false;
  let readyState = 1;
  const emit = (type: string, data?: unknown): void => {
    for (const listener of listeners.get(type) ?? []) {
      listener({
        data,
      });
    }
  };
  const reply = (frame: RunnerFrame): void => {
    emit('message', JSON.stringify(RunnerFrameSchema.parse(frame)));
  };
  const answer = (frame: HostFrame): void => {
    if (frame.t !== 'start') {
      return;
    }
    reply({
      t: 'started',
      id: frame.id,
    });
    reply({
      t: 'stdout',
      id: frame.id,
      data: btoa(`ran ${frame.command}`),
    });
    reply({
      t: 'exit',
      id: frame.id,
      code: 0,
    });
  };
  const socket: UpgradedSocketLike = {
    get readyState() {
      return readyState;
    },
    accept() {
      accepted = true;
    },
    send(data) {
      assert(accepted, 'a socket must be accepted before it is used');
      const frame = HostFrameSchema.parse(JSON.parse(data));
      received.push(frame);
      queueMicrotask(() => answer(frame));
    },
    close() {
      readyState = 3;
      queueMicrotask(() => emit('close'));
    },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [
        ...(listeners.get(type) ?? []),
        listener,
      ]);
    },
  };
  return {
    socket,
    far: {
      received,
      closed: () => readyState === 3,
    },
  };
}

//#endregion

describe('createSocketSubprocessAdapter', () => {
  it('runs a process through the socket the object accepted, one socket per link', async () => {
    const sockets: Array<ReturnType<typeof runnerSocket>> = [];
    const adapter = createSocketSubprocessAdapter((): WebSocketLike => {
      const next = runnerSocket();
      next.socket.accept();
      sockets.push(next);
      return next.socket;
    });
    const link = await adapter.open({});
    const process = await link.spawn({
      command: 'build',
    });
    expect(await new Response(process.readable).text()).toBe('ran build');
    expect(await process.exited).toBe(0);
    await link.close();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.far.closed()).toBe(true);

    const settled = await (
      await adapter.spawn({
        command: 'test',
      })
    ).settled;
    expect(settled.status).toBe('completed');
    expect(settled.metadata?.runtime).toBe('runner');
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.far.received.map((frame) => frame.t)).toEqual([
      'keep',
      'start',
    ]);
  });

  it('refuses a step request', async () => {
    const adapter = createSocketSubprocessAdapter(() => runnerSocket().socket);
    const refusal = await adapter
      .spawn({
        kind: 'step',
        stepId: 'plan',
        serializedInput: null,
        executionId: 'e-1',
        overrides: {},
      })
      .catch((e: unknown) => e);
    assert(isNoeticConfigError(refusal));
    expect(refusal.code).toBe('SUBPROCESS_RUNS_NO_STEPS');
  });
});

describe('createFetchSubprocessAdapter', () => {
  it('upgrades with the bearer token over https and accepts the socket', async () => {
    const requests: Array<{
      url: string;
      headers: Record<string, string>;
    }> = [];
    const { socket, far } = runnerSocket();
    const upgrade: UpgradeFetchLike = async (url, init) => {
      requests.push({
        url,
        headers: init.headers,
      });
      return {
        status: 101,
        webSocket: socket,
      };
    };
    const adapter = createFetchSubprocessAdapter({
      url: 'wss://runner.example.com/acp',
      token: 'secret-token',
      fetch: upgrade,
    });
    const link = await adapter.open({});
    const process = await link.spawn({
      command: 'build',
    });
    expect(await new Response(process.readable).text()).toBe('ran build');
    await link.close();
    expect(requests).toEqual([
      {
        url: 'https://runner.example.com/acp',
        headers: {
          Upgrade: 'websocket',
          Authorization: 'Bearer secret-token',
        },
      },
    ]);
    expect(far.closed()).toBe(true);
  });

  it('reports a runner that answers without a socket', async () => {
    const adapter = createFetchSubprocessAdapter({
      url: 'wss://runner.example.com',
      token: 'wrong',
      fetch: async () => ({
        status: 401,
      }),
    });
    const failure = await adapter.open({}).catch((e: unknown) => e);
    assert(isAcpConnectError(failure));
    expect(failure.message).toContain('HTTP 401');
  });

  it('reports a runner it cannot reach', async () => {
    const adapter = createFetchSubprocessAdapter({
      url: 'ws://127.0.0.1:9',
      token: 't',
      fetch: async () => {
        throw new Error('connection refused');
      },
    });
    const failure = await adapter.open({}).catch((e: unknown) => e);
    assert(isAcpConnectError(failure));
    expect(failure.message).toContain('connection refused');
  });

  it('refuses ws:// to a host that is not loopback', () => {
    expect(() =>
      createFetchSubprocessAdapter({
        url: 'ws://runner.example.com',
        token: 't',
      }),
    ).toThrow('wss://');
  });
});
