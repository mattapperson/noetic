/**
 * A subprocess adapter built from `open` alone: every process it runs starts
 * through a link, wherever that link leads.
 */

import type {
  ByteStream,
  ProcessSubprocessRequest,
  SpawnedSubprocess,
  SubprocessAdapter,
  SubprocessControlResult,
  SubprocessHandle,
  SubprocessHandleMetadata,
  SubprocessLink,
  SubprocessOpen,
} from '@noetic-tools/types';
import { chunksOf, NoeticConfigError } from '@noetic-tools/types';
import { nowIso, serializeError } from './in-memory-subprocess/metadata';
import { createLiveHandles } from './live-handles';

//#region Types

/** @public Options for {@link createLinkSubprocessAdapter}. */
export interface CreateLinkSubprocessAdapterOptions {
  /** `metadata.runtime` on every handle. Default `'link'`. */
  runtime?: string;
}

/** How a command run over a link ended. */
interface Outcome {
  /** What the command wrote, for a run that was given input; only such a run has a result. */
  stdout?: string;
  /** Undefined when the link reports no exit: the stream ending is all there is. */
  exitCode?: number | null;
}

//#endregion

//#region Public API

/**
 * A subprocess adapter for a place reached only through `open`. A `process`
 * request starts its command with the link's `spawn`, on a link of its own,
 * and settles as the local adapter settles one: with `stdin`, stdout is the
 * handle's `result` when the command exits 0, and any other exit fails the
 * handle. A link carries no stderr, so a failure names the exit code alone,
 * and `detached` means nothing there. A `step` request needs the Noetic
 * runtime on the far side and is refused.
 *
 * An adapter that also runs steps spreads this one and adds its own `spawn`
 * for them.
 *
 * @throws `NoeticConfigError` `SUBPROCESS_RUNS_NO_STEPS` from `spawn` for a `step` request.
 * @public
 */
export function createLinkSubprocessAdapter(
  open: SubprocessOpen,
  options: CreateLinkSubprocessAdapterOptions = {},
): SubprocessAdapter & {
  open: SubprocessOpen;
} {
  const runtime = options.runtime ?? 'link';
  const live = createLiveHandles();
  /** Stops each running command, by handle id. */
  const release = new Map<string, () => Promise<void>>();

  async function settle(handleId: string, run: Promise<Outcome>): Promise<void> {
    const outcome = await run.then(
      (ended) => finished(ended),
      (error: unknown): Finished => ({
        status: 'failed',
        metadata: {
          error: serializeError(error),
        },
      }),
    );
    const stop = release.get(handleId);
    release.delete(handleId);
    // A stopped handle has already settled; its late outcome is dropped.
    const latest = live.get(handleId);
    if (latest) {
      live.settle({
        ...latest,
        status: outcome.status,
        updatedAt: nowIso(),
        metadata: {
          ...(latest.metadata ?? {}),
          ...outcome.metadata,
        },
      });
    }
    await stop?.();
  }

  async function spawnProcess(request: ProcessSubprocessRequest): Promise<SpawnedSubprocess> {
    // A command run to completion has no later host to wait for.
    const link = await open({
      whenHostExits: 'stop',
    });
    const stream = await startOn(link, request);
    const now = nowIso();
    const spawned = live.add({
      id: `subprocess-${crypto.randomUUID()}`,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      metadata: {
        ...(request.metadata ?? {}),
        runtime,
        command: request.command,
        args: request.args ?? [],
        cwd: request.cwd,
      },
    });
    release.set(spawned.handle.id, async () => {
      await stream.close().catch(() => undefined);
      await link.close().catch(() => undefined);
    });
    void settle(spawned.handle.id, runToExit(stream, request.stdin));
    return spawned;
  }

  const unsupported = async (handleId: string): Promise<SubprocessControlResult> => {
    const handle = live.get(handleId);
    return handle
      ? {
          kind: 'unsupported',
          handle,
          message: 'A process run over a link cannot be paused.',
        }
      : {
          kind: 'not_found',
          handleId,
        };
  };

  return {
    open,
    async spawn(request) {
      if (request.kind === 'step') {
        throw new NoeticConfigError({
          code: 'SUBPROCESS_RUNS_NO_STEPS',
          message: `This subprocess adapter ('${runtime}') runs commands and holds their stdio; it cannot run step '${request.stepId}', which needs the Noetic runtime and the program's code where it runs.`,
          hint: 'Run steps through an adapter that has both — `createLocalSubprocessAdapter()` from @noetic-tools/platform-node, or the in-memory default — and name this one where a command or an agent should run (`subprocess: <name>`).',
        });
      }
      return await spawnProcess(request);
    },
    get: async (handleId) => live.get(handleId) ?? null,
    async stop(handleId, reason) {
      const handle = live.get(handleId);
      if (!handle) {
        return {
          kind: 'not_found',
          handleId,
        };
      }
      const next: SubprocessHandle = {
        ...handle,
        status: 'stopped',
        updatedAt: nowIso(),
        metadata: {
          ...(handle.metadata ?? {}),
          stopReason: reason,
        },
      };
      live.settle(next);
      const stop = release.get(handleId);
      release.delete(handleId);
      await stop?.();
      return {
        kind: 'stopped',
        handleId,
        handle: next,
      };
    },
    pause: unsupported,
    resume: unsupported,
    isAlive: async (handle) => live.get(handle.id) !== undefined,
    // A link's processes end with it, so none is left for a later host.
    reattach: async () => null,
    listLive: async () => [
      ...live.values(),
    ],
  };
}

//#endregion

//#region Helpers

interface Finished {
  status: 'completed' | 'failed';
  metadata: SubprocessHandleMetadata;
}

async function startOn(
  link: SubprocessLink,
  request: ProcessSubprocessRequest,
): Promise<ByteStream> {
  try {
    return await link.spawn({
      command: request.command,
      args: request.args,
      env: request.env,
      cwd: request.cwd,
    });
  } catch (error) {
    await link.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Feed the command `stdin` (none is an empty input, as the local adapter
 * gives a command it does not capture) and read its stdout to the end.
 */
async function runToExit(stream: ByteStream, stdin: string | undefined): Promise<Outcome> {
  // A command that exits without reading its input closes the pipe; that is its business.
  const fed = feed(stream.writable, stdin).catch(() => undefined);
  const decoder = new TextDecoder();
  let stdout = '';
  for await (const chunk of chunksOf(stream.readable)) {
    stdout += decoder.decode(chunk, {
      stream: true,
    });
  }
  await fed;
  return {
    ...(stdin === undefined
      ? {}
      : {
          stdout: stdout + decoder.decode(),
        }),
    ...(stream.exited
      ? {
          exitCode: await stream.exited,
        }
      : {}),
  };
}

async function feed(
  writable: WritableStream<Uint8Array>,
  stdin: string | undefined,
): Promise<void> {
  const writer = writable.getWriter();
  if (stdin) {
    await writer.write(new TextEncoder().encode(stdin));
  }
  await writer.close();
}

function finished(outcome: Outcome): Finished {
  const failed = outcome.exitCode !== undefined && outcome.exitCode !== 0;
  const metadata: SubprocessHandleMetadata = {};
  if (outcome.exitCode !== undefined) {
    metadata.exitCode = outcome.exitCode;
  }
  if (failed) {
    metadata.error = {
      message: `Subprocess exited with code ${outcome.exitCode ?? 'null'}`,
    };
  } else if (outcome.stdout !== undefined) {
    metadata.result = outcome.stdout;
  }
  return {
    status: failed ? 'failed' : 'completed',
    metadata,
  };
}

//#endregion
