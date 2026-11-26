/**
 * The host's end of a remote runner, against a scripted runner: every frame
 * it sends is a `HostFrame`, and a `process` request settles from the
 * runner's `exit` frame.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { FrameLink, HostFrame, RunnerFrame } from '@noetic-tools/types';
import {
  HostFrameSchema,
  isNoeticConfigError,
  RunnerFrameSchema,
  toBase64,
} from '@noetic-tools/types';
import {
  bridgeTarget,
  createRunnerSubprocessAdapter,
} from '../../src/adapters/runner-subprocess-adapter';

//#region Fixtures

/** A runner that answers each `start` with the output and exit code `run` gives the command. */
function scriptedRunner(
  run: (command: string) => {
    stdout: string;
    code: number;
  },
): {
  dial: () => Promise<FrameLink>;
  sent: HostFrame[];
  closed: () => number;
} {
  const sent: HostFrame[] = [];
  let closed = 0;
  const dial = async (): Promise<FrameLink> => {
    let deliver: (frame: unknown) => void = () => undefined;
    const closeListeners: Array<() => void> = [];
    const reply = (frame: RunnerFrame): void => {
      // The host must take exactly what a runner may send.
      deliver(RunnerFrameSchema.parse(frame));
    };
    const answer = (frame: HostFrame): void => {
      if (frame.t !== 'start') {
        return;
      }
      const outcome = run(frame.command);
      reply({
        t: 'started',
        id: frame.id,
      });
      reply({
        t: 'stdout',
        id: frame.id,
        data: toBase64(new TextEncoder().encode(outcome.stdout)),
      });
      reply({
        t: 'exit',
        id: frame.id,
        code: outcome.code,
      });
    };
    return {
      send(frame) {
        // Every frame the host sends must be one a runner takes.
        const parsed = HostFrameSchema.parse(frame);
        sent.push(parsed);
        queueMicrotask(() => answer(parsed));
      },
      onFrame(listener) {
        deliver = listener;
      },
      onClose(listener) {
        closeListeners.push(() => listener());
      },
      async close() {
        closed += 1;
        for (const listener of closeListeners) {
          listener();
        }
      },
    };
  };
  return {
    dial,
    sent,
    closed: () => closed,
  };
}

const quiet = () => ({
  stdout: '',
  code: 0,
});

//#endregion

describe('createRunnerSubprocessAdapter', () => {
  it('runs a process request as a spawn on the runner and settles from its exit frame', async () => {
    const runner = scriptedRunner(quiet);
    const adapter = createRunnerSubprocessAdapter(runner.dial);
    const spawned = await adapter.spawn({
      command: 'make',
      args: [
        'build',
      ],
      cwd: '/work',
      env: {
        KEEP: 'yes',
        DROP: undefined,
      },
    });
    const settled = await spawned.settled;
    expect(settled.status).toBe('completed');
    expect(settled.metadata).toMatchObject({
      runtime: 'runner',
      command: 'make',
      exitCode: 0,
    });
    expect(runner.sent.map((frame) => frame.t)).toEqual([
      'keep',
      'start',
    ]);
    expect(runner.sent[1]).toMatchObject({
      t: 'start',
      kind: 'spawn',
      command: 'make',
      args: [
        'build',
      ],
      cwd: '/work',
      env: {
        KEEP: 'yes',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runner.closed()).toBe(1);
  });

  it('fails the handle when the command exits non-zero', async () => {
    const runner = scriptedRunner(() => ({
      stdout: '',
      code: 2,
    }));
    const settled = await (
      await createRunnerSubprocessAdapter(runner.dial).spawn({
        command: 'make',
      })
    ).settled;
    expect(settled.status).toBe('failed');
    expect(settled.metadata?.error?.message).toBe('Subprocess exited with code 2');
  });

  it("carries a held process's stdout and exit code through open", async () => {
    const runner = scriptedRunner(() => ({
      stdout: 'hello',
      code: 0,
    }));
    const link = await createRunnerSubprocessAdapter(runner.dial).open({});
    const process = await link.spawn({
      command: 'greet',
    });
    expect(await new Response(process.readable).text()).toBe('hello');
    expect(await process.exited).toBe(0);
    await link.close();
  });

  it('refuses a process request with stdin: its frames carry no end of input', async () => {
    const runner = scriptedRunner(quiet);
    const refusal = await createRunnerSubprocessAdapter(runner.dial)
      .spawn({
        command: 'node',
        stdin: 'input',
      })
      .catch((e: unknown) => e);
    assert(isNoeticConfigError(refusal));
    expect(refusal.code).toBe('SUBPROCESS_CANNOT_END_INPUT');
    expect(runner.sent).toEqual([]);
  });

  it('refuses a step request: a runner has no Noetic runtime', async () => {
    const runner = scriptedRunner(quiet);
    const refusal = await createRunnerSubprocessAdapter(runner.dial)
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
    expect(runner.sent).toEqual([]);
  });
});

describe('bridgeTarget', () => {
  const bridges = new Map([
    [
      '/mcp/abc',
      'http://127.0.0.1:4321',
    ],
  ]);

  it('forwards the checked path to the bridge origin', () => {
    expect(bridgeTarget(bridges, '/mcp/abc?x=1')?.href).toBe('http://127.0.0.1:4321/mcp/abc?x=1');
  });

  it('never leaves the bridge origin for a path that only parses to it', () => {
    for (const path of [
      '0/../mcp/abc',
      '1/../mcp/abc?x',
      'a:/mcp/abc',
      '//evil.example/mcp/abc',
    ]) {
      const target = bridgeTarget(bridges, path);
      assert(target);
      expect(target.origin).toBe('http://127.0.0.1:4321');
      expect(target.pathname).toBe('/mcp/abc');
    }
  });

  it('forwards nothing for a path no bridge serves', () => {
    expect(bridgeTarget(bridges, '/other')).toBeUndefined();
  });
});
