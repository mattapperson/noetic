/**
 * The runner adapters against a real runner (`noetic-acp serve`): a `process`
 * request runs there and settles on its exit; one with `stdin`, and a `step`
 * request, are refused.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import type { AcpRunnerListener } from '@noetic-tools/acp/remote';
import { listenAcpRunner } from '@noetic-tools/acp/remote';
import type { SubprocessAdapter } from '@noetic-tools/core';
import { isNoeticConfigError } from '@noetic-tools/core';
import {
  createCommandSubprocessAdapter,
  createWebSocketSubprocessAdapter,
} from '../src/runner-subprocess-adapters';

const TOKEN = 'runner-adapters-test-token-0123456789';
const RUNNER_BIN = createRequire(import.meta.url)
  .resolve('@noetic-tools/acp/package.json')
  .replace(/package\.json$/, 'src/bin.ts');

const ECHO_UPPER =
  "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.toUpperCase()))";

function overStdio(): SubprocessAdapter {
  return createCommandSubprocessAdapter({
    command: process.execPath,
    args: [
      RUNNER_BIN,
      'serve',
      '--stdio',
    ],
  });
}

describe('a process request through a remote runner', () => {
  let listener: AcpRunnerListener;
  let overWebSocket: SubprocessAdapter;
  beforeAll(async () => {
    listener = await listenAcpRunner({
      token: TOKEN,
    });
    overWebSocket = createWebSocketSubprocessAdapter({
      url: listener.url,
      token: TOKEN,
    });
  });
  afterAll(async () => {
    await listener.close();
  });

  it.each([
    [
      'over WebSocket',
      () => overWebSocket,
    ],
    [
      "over a command's stdio",
      overStdio,
    ],
  ])('%s, runs the command there and settles on its exit', async (_label, adapter) => {
    const { handle, settled } = await adapter().spawn({
      kind: 'process',
      command: 'node',
      args: [
        '-e',
        'process.exit(0)',
      ],
    });
    expect(handle.metadata?.runtime).toBe('runner');
    const done = await settled;
    expect(done.status).toBe('completed');
    expect(done.metadata?.exitCode).toBe(0);
  });

  it('fails the handle on a non-zero exit', async () => {
    const { settled } = await overWebSocket.spawn({
      command: 'node',
      args: [
        '-e',
        'process.exit(3)',
      ],
    });
    const done = await settled;
    expect(done.status).toBe('failed');
    expect(done.metadata?.exitCode).toBe(3);
    expect(done.metadata?.error?.message).toBe('Subprocess exited with code 3');
  });

  it('stop ends the command on the runner', async () => {
    const { handle, settled } = await overWebSocket.spawn({
      command: 'node',
      args: [
        '-e',
        'setInterval(() => {}, 1000)',
      ],
    });
    expect((await overWebSocket.stop(handle.id, 'enough')).kind).toBe('stopped');
    expect((await settled).status).toBe('stopped');
  });

  it('refuses a request with stdin, as a runCode node sends, instead of hanging', async () => {
    const refusal = await overWebSocket
      .spawn({
        command: 'node',
        args: [
          '-e',
          ECHO_UPPER,
        ],
        stdin: 'hello',
      })
      .catch((e: unknown) => e);
    assert(isNoeticConfigError(refusal));
    expect(refusal.code).toBe('SUBPROCESS_CANNOT_END_INPUT');
  });

  it('refuses a step request', async () => {
    const refusal = await overWebSocket
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

describe('createWebSocketSubprocessAdapter', () => {
  it('refuses ws:// to a host that is not loopback', () => {
    expect(() =>
      createWebSocketSubprocessAdapter({
        url: 'ws://build.example.com:8080',
        token: TOKEN,
      }),
    ).toThrow('wss://');
  });

  it('reports a runner that refuses the token', async () => {
    const listener = await listenAcpRunner({
      token: TOKEN,
    });
    try {
      const failure = await createWebSocketSubprocessAdapter({
        url: listener.url,
        token: 'wrong',
      })
        .open({})
        .catch((e: unknown) => e);
      expect(String(failure)).toContain('refused the connection');
    } finally {
      await listener.close();
    }
  });
});
