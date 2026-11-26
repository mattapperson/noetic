/**
 * An adapter built from `open` alone runs a `process` request through a link
 * and settles its handle as the local adapter does; it refuses a `step`.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ByteStream, SpawnCommand, SubprocessLink } from '@noetic-tools/types';
import { isNoeticConfigError } from '@noetic-tools/types';
import { createLinkSubprocessAdapter } from '../../src/adapters/link-subprocess-adapter';

//#region Fixtures

interface FarSide {
  /** What the command prints for the input it read. */
  stdout?(stdin: string): string;
  /** Its exit code; `'unreported'` leaves `exited` off the stream. */
  exit?: number | null | 'unreported';
  /** Never exits until its stream is closed. */
  hangs?: boolean;
  /** The link's `spawn` rejects. */
  refuses?: boolean;
}

interface Seen {
  commands: SpawnCommand[];
  opened: number;
  linksClosed: number;
  streamsClosed: number;
}

/** A link whose `spawn` plays a command: reads its stdin to the end, writes its stdout, exits. */
function fakeLink(far: FarSide, seen: Seen): SubprocessLink {
  return {
    reach: async (bridge) => bridge,
    launch: async () => {
      throw new Error('not launched in these tests');
    },
    async spawn(command) {
      seen.commands.push(command);
      if (far.refuses) {
        throw new Error(`cannot start ${command.command}`);
      }
      const input = new TransformStream<Uint8Array, Uint8Array>();
      const output = new TransformStream<Uint8Array, Uint8Array>();
      let exit = (_code: number | null): void => undefined;
      const exited = new Promise<number | null>((resolve) => {
        exit = resolve;
      });
      const writer = output.writable.getWriter();
      const play = async (): Promise<void> => {
        const stdin = await new Response(input.readable).text();
        if (far.hangs) {
          return;
        }
        await writer.write(new TextEncoder().encode(far.stdout?.(stdin) ?? ''));
        await writer.close();
        exit(far.exit === 'unreported' || far.exit === undefined ? 0 : far.exit);
      };
      void play();
      const stream: ByteStream = {
        readable: output.readable,
        writable: input.writable,
        async close() {
          seen.streamsClosed += 1;
          await writer.close().catch(() => undefined);
          exit(null);
        },
        ...(far.exit === 'unreported'
          ? {}
          : {
              exited,
            }),
      };
      return stream;
    },
    async close() {
      seen.linksClosed += 1;
    },
  };
}

function adapterOn(far: FarSide = {}) {
  const seen: Seen = {
    commands: [],
    opened: 0,
    linksClosed: 0,
    streamsClosed: 0,
  };
  const adapter = createLinkSubprocessAdapter(
    async () => {
      seen.opened += 1;
      return fakeLink(far, seen);
    },
    {
      runtime: 'far',
    },
  );
  return {
    adapter,
    seen,
  };
}

//#endregion

describe('a process request over a link', () => {
  it('writes stdin, and stores stdout as the result when the command exits 0', async () => {
    const { adapter, seen } = adapterOn({
      stdout: (stdin) => stdin.toUpperCase(),
    });
    const spawned = await adapter.spawn({
      kind: 'process',
      command: 'shout',
      args: [
        '-v',
      ],
      cwd: '/work',
      env: {
        MODE: 'loud',
      },
      stdin: 'hello',
      metadata: {
        noeticRun: true,
      },
    });
    expect(spawned.handle.status).toBe('running');
    expect(await adapter.get(spawned.handle.id)).toEqual(spawned.handle);
    const settled = await spawned.settled;
    expect(settled.status).toBe('completed');
    expect(settled.metadata).toMatchObject({
      noeticRun: true,
      runtime: 'far',
      command: 'shout',
      args: [
        '-v',
      ],
      cwd: '/work',
      exitCode: 0,
      result: 'HELLO',
    });
    expect(seen.commands).toEqual([
      {
        command: 'shout',
        args: [
          '-v',
        ],
        cwd: '/work',
        env: {
          MODE: 'loud',
        },
      },
    ]);
    // Settled means forgotten; the link it ran on is released just after.
    expect(await adapter.get(spawned.handle.id)).toBeNull();
    expect(await adapter.listLive()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen.linksClosed).toBe(1);
  });

  it('fails the handle on any other exit, with no result', async () => {
    const { adapter } = adapterOn({
      stdout: () => 'partial',
      exit: 3,
    });
    const settled = await (
      await adapter.spawn({
        command: 'break',
        stdin: '',
      })
    ).settled;
    expect(settled.status).toBe('failed');
    expect(settled.metadata?.exitCode).toBe(3);
    expect(settled.metadata?.error).toEqual({
      message: 'Subprocess exited with code 3',
    });
    expect(settled.metadata?.result).toBeUndefined();
  });

  it('keeps no result for a request with no stdin', async () => {
    const { adapter } = adapterOn({
      stdout: () => 'noise',
    });
    const settled = await (
      await adapter.spawn({
        command: 'daemon',
      })
    ).settled;
    expect(settled.status).toBe('completed');
    expect(settled.metadata?.result).toBeUndefined();
  });

  it('completes on the stream ending where the link reports no exit', async () => {
    const { adapter } = adapterOn({
      stdout: () => 'out',
      exit: 'unreported',
    });
    const settled = await (
      await adapter.spawn({
        command: 'quiet',
        stdin: 'in',
      })
    ).settled;
    expect(settled.status).toBe('completed');
    expect(settled.metadata?.result).toBe('out');
    expect(settled.metadata).not.toHaveProperty('exitCode');
  });

  it('stop settles the handle as stopped and closes its stream and link', async () => {
    const { adapter, seen } = adapterOn({
      hangs: true,
    });
    const spawned = await adapter.spawn({
      command: 'forever',
      stdin: '',
    });
    expect(await adapter.isAlive(spawned.handle)).toBe(true);
    expect((await adapter.pause(spawned.handle.id)).kind).toBe('unsupported');
    const stopped = await adapter.stop(spawned.handle.id, 'enough');
    expect(stopped.kind).toBe('stopped');
    const settled = await spawned.settled;
    expect(settled.status).toBe('stopped');
    expect(settled.metadata?.stopReason).toBe('enough');
    expect(seen.streamsClosed).toBe(1);
    expect(seen.linksClosed).toBe(1);
    expect(await adapter.isAlive(spawned.handle)).toBe(false);
    expect(await adapter.stop(spawned.handle.id)).toEqual({
      kind: 'not_found',
      handleId: spawned.handle.id,
    });
  });

  it('rejects, closing the link, when the command cannot start', async () => {
    const { adapter, seen } = adapterOn({
      refuses: true,
    });
    const failure = await adapter
      .spawn({
        command: 'missing',
      })
      .catch((e: unknown) => e);
    expect(String(failure)).toContain('cannot start missing');
    expect(seen.linksClosed).toBe(1);
    expect(await adapter.listLive()).toEqual([]);
  });
});

describe('a step request to an adapter built from open alone', () => {
  it('is refused before any link opens', async () => {
    const { adapter, seen } = adapterOn();
    const refusal = await adapter
      .spawn({
        kind: 'step',
        stepId: 'summarize',
        serializedInput: null,
        executionId: 'e-1',
        overrides: {},
      })
      .catch((e: unknown) => e);
    assert(isNoeticConfigError(refusal));
    expect(refusal.code).toBe('SUBPROCESS_RUNS_NO_STEPS');
    expect(refusal.message).toContain("'summarize'");
    expect(refusal.hint).toContain('createLocalSubprocessAdapter()');
    expect(seen.opened).toBe(0);
    expect(await adapter.reattach('h-1')).toBeNull();
    expect(await adapter.pause('h-1')).toEqual({
      kind: 'not_found',
      handleId: 'h-1',
    });
  });
});
