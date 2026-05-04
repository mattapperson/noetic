import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import type {
  SubprocessAdapter,
  SubprocessControlResult,
  SubprocessHandle,
  SubprocessRequest,
  SubprocessStopResult,
} from '../types/subprocess-adapter';

export type SubprocessSignal = 'SIGTERM' | 'SIGSTOP' | 'SIGCONT';

export interface ProcessSignaller {
  kill(target: number, signal: SubprocessSignal): void;
  isAlive(pid: number): boolean;
  startTime(pid: number): string | null;
}

export interface CreateLocalSubprocessAdapterOptions {
  spawnFn?: (
    command: string,
    args: ReadonlyArray<string>,
    options: SpawnOptions,
  ) => Pick<ChildProcess, 'pid' | 'unref'> & {
    on(event: 'error', listener: (err: Error) => void): unknown;
  };
  signaller?: ProcessSignaller;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

function readPidStartTime(pid: number): string | null {
  try {
    const out = execFileSync(
      'ps',
      [
        '-p',
        String(pid),
        '-o',
        'lstart=',
      ],
      {
        stdio: [
          'ignore',
          'pipe',
          'ignore',
        ],
        encoding: 'utf8',
      },
    ).trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}

export const defaultProcessSignaller: ProcessSignaller = {
  kill(target, signal) {
    process.kill(target, signal);
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return isErrnoException(err) && err.code === 'EPERM';
    }
  },
  startTime(pid) {
    return readPidStartTime(pid);
  },
};

function nowIso(): string {
  return new Date().toISOString();
}

export function createLocalSubprocessAdapter(
  options: CreateLocalSubprocessAdapterOptions = {},
): SubprocessAdapter {
  const signaller = options.signaller ?? defaultProcessSignaller;
  const spawnFn = options.spawnFn ?? ((command, args, opts) => spawn(command, args.slice(), opts));
  const handles = new Map<string, SubprocessHandle>();

  async function save(handle: SubprocessHandle): Promise<SubprocessHandle> {
    handles.set(handle.id, handle);
    return handle;
  }

  async function patch(
    handle: SubprocessHandle,
    status: SubprocessHandle['status'],
  ): Promise<SubprocessHandle> {
    return save({
      ...handle,
      status,
      updatedAt: nowIso(),
    });
  }

  function pidFor(handle: SubprocessHandle): number | null {
    return typeof handle.metadata?.pid === 'number' ? handle.metadata.pid : null;
  }

  return {
    async spawn(request: SubprocessRequest) {
      let asyncSpawnError: unknown = null;
      const child = spawnFn(request.command, request.args ?? [], {
        cwd: request.cwd,
        detached: request.detached ?? false,
        stdio: 'ignore',
        env: request.env
          ? {
              ...process.env,
              ...request.env,
            }
          : undefined,
      });
      child.on('error', (err) => {
        asyncSpawnError = err;
      });
      child.unref();

      if (child.pid === undefined || !signaller.isAlive(child.pid)) {
        throw new Error(
          asyncSpawnError instanceof Error
            ? asyncSpawnError.message
            : `Subprocess failed to start: ${request.command}`,
        );
      }

      const now = nowIso();
      return save({
        id: `subprocess-${crypto.randomUUID()}`,
        status: 'running',
        startedAt: now,
        updatedAt: now,
        metadata: {
          ...(request.metadata ?? {}),
          runtime: 'local',
          pid: child.pid,
          pidStarttime: signaller.startTime(child.pid),
          command: request.command,
          args: request.args ?? [],
          cwd: request.cwd,
          detached: request.detached ?? false,
        },
      });
    },
    async get(handleId) {
      return handles.get(handleId) ?? null;
    },
    async stop(handleId, reason): Promise<SubprocessStopResult> {
      const handle = handles.get(handleId);
      if (!handle) {
        return {
          kind: 'not_found',
          handleId,
        };
      }
      const pid = pidFor(handle);
      if (pid !== null) {
        try {
          signaller.kill(handle.metadata?.detached === true ? -pid : pid, 'SIGTERM');
        } catch {
          /* process may already be gone */
        }
      }
      const next = await patch(
        {
          ...handle,
          metadata: {
            ...(handle.metadata ?? {}),
            stopReason: reason,
          },
        },
        'stopped',
      );
      return {
        kind: 'stopped',
        handleId,
        handle: next,
      };
    },
    async pause(handleId): Promise<SubprocessControlResult> {
      const handle = handles.get(handleId);
      if (!handle) {
        return {
          kind: 'not_found',
          handleId,
        };
      }
      const pid = pidFor(handle);
      if (pid === null) {
        return {
          kind: 'unsupported',
          handle,
          message: 'Subprocess handle has no pid metadata.',
        };
      }
      signaller.kill(handle.metadata?.detached === true ? -pid : pid, 'SIGSTOP');
      return {
        kind: 'ok',
        handle: await patch(handle, 'paused'),
      };
    },
    async resume(handleId): Promise<SubprocessControlResult> {
      const handle = handles.get(handleId);
      if (!handle) {
        return {
          kind: 'not_found',
          handleId,
        };
      }
      const pid = pidFor(handle);
      if (pid === null) {
        return {
          kind: 'unsupported',
          handle,
          message: 'Subprocess handle has no pid metadata.',
        };
      }
      signaller.kill(handle.metadata?.detached === true ? -pid : pid, 'SIGCONT');
      return {
        kind: 'ok',
        handle: await patch(handle, 'running'),
      };
    },
    async isAlive(handle) {
      const pid = pidFor(handle);
      return pid !== null && signaller.isAlive(pid);
    },
  };
}
