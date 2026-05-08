import { describe, expect, it } from 'bun:test';
import { TIMEOUT_ERROR_PREFIX } from '@noetic/core';
import { createMirageShellAdapter } from '../src/shell-adapter';
import type { MirageExecuteOptions, MirageExecuteResult, MirageWorkspace } from '../src/types';

function makeRecordingWorkspace(
  handler: (command: string, options?: MirageExecuteOptions) => MirageExecuteResult,
): MirageWorkspace & {
  calls: Array<{
    command: string;
    options?: MirageExecuteOptions;
  }>;
} {
  const calls: Array<{
    command: string;
    options?: MirageExecuteOptions;
  }> = [];
  return {
    calls,
    async execute(command: string, options?: MirageExecuteOptions): Promise<MirageExecuteResult> {
      calls.push({
        command,
        options,
      });
      return handler(command, options);
    },
  };
}

describe('createMirageShellAdapter', () => {
  it('passes command, cwd, env, stdin, and signal through to workspace.execute', async () => {
    const ws = makeRecordingWorkspace(() => ({
      stdout: new TextEncoder().encode('ok\n'),
      stderr: new Uint8Array(0),
      exitCode: 0,
    }));
    const shell = createMirageShellAdapter(ws);
    const controller = new AbortController();
    const result = await shell.exec('echo hi', {
      cwd: '/local',
      env: {
        FOO: 'bar',
      },
      stdin: 'stuff',
      signal: controller.signal,
    });
    expect(result.stdout).toBe('ok\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(ws.calls.length).toBe(1);
    const call = ws.calls[0];
    expect(call.command).toBe('echo hi');
    expect(call.options?.cwd).toBe('/local');
    expect(call.options?.env).toEqual({
      FOO: 'bar',
    });
    expect(call.options?.stdin).toBe('stuff');
    expect(call.options?.signal).toBeDefined();
  });

  it('decodes stdout/stderr as UTF-8', async () => {
    const ws = makeRecordingWorkspace(() => ({
      stdout: new TextEncoder().encode('café\n'),
      stderr: new TextEncoder().encode('ミラージュ\n'),
      exitCode: 0,
    }));
    const shell = createMirageShellAdapter(ws);
    const result = await shell.exec('whatever', {
      cwd: '/',
    });
    expect(result.stdout).toBe('café\n');
    expect(result.stderr).toBe('ミラージュ\n');
  });

  it('propagates non-zero exit codes', async () => {
    const ws = makeRecordingWorkspace(() => ({
      stdout: new Uint8Array(0),
      stderr: new TextEncoder().encode('nope'),
      exitCode: 2,
    }));
    const shell = createMirageShellAdapter(ws);
    const result = await shell.exec('false', {
      cwd: '/',
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('nope');
  });

  it('invokes onData with the full stdout Buffer when result is non-empty', async () => {
    const ws = makeRecordingWorkspace(() => ({
      stdout: new TextEncoder().encode('hello'),
      stderr: new Uint8Array(0),
      exitCode: 0,
    }));
    const shell = createMirageShellAdapter(ws);
    const chunks: Buffer[] = [];
    await shell.exec('echo hello', {
      cwd: '/',
      onData: (data) => chunks.push(data),
    });
    expect(chunks.length).toBe(1);
    expect(chunks[0].toString('utf-8')).toBe('hello');
  });

  it('does not invoke onData when stdout is empty', async () => {
    const ws = makeRecordingWorkspace(() => ({
      stdout: new Uint8Array(0),
      stderr: new Uint8Array(0),
      exitCode: 0,
    }));
    const shell = createMirageShellAdapter(ws);
    let called = false;
    await shell.exec('true', {
      cwd: '/',
      onData: () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });

  it('rejects with TIMEOUT_ERROR_PREFIX when the timeout fires', async () => {
    const ws: MirageWorkspace = {
      async execute(_cmd: string, options?: MirageExecuteOptions): Promise<MirageExecuteResult> {
        // Wait for abort; throw DOMException-like error when signalled.
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      },
    };
    const shell = createMirageShellAdapter(ws);
    await expect(
      shell.exec('sleep forever', {
        cwd: '/',
        timeout: 0.05,
      }),
    ).rejects.toThrow(`${TIMEOUT_ERROR_PREFIX}0.05`);
  });

  it('forwards the caller signal alongside the internal timeout signal', async () => {
    let capturedSignal: AbortSignal | undefined;
    const ws: MirageWorkspace = {
      async execute(_cmd: string, options?: MirageExecuteOptions): Promise<MirageExecuteResult> {
        capturedSignal = options?.signal;
        return {
          stdout: new Uint8Array(0),
          stderr: new Uint8Array(0),
          exitCode: 0,
        };
      },
    };
    const shell = createMirageShellAdapter(ws);
    const outer = new AbortController();
    await shell.exec('true', {
      cwd: '/',
      signal: outer.signal,
    });
    expect(capturedSignal).toBeDefined();
  });

  it('re-throws non-timeout errors unchanged', async () => {
    const ws: MirageWorkspace = {
      async execute(): Promise<MirageExecuteResult> {
        throw new Error('workspace blew up');
      },
    };
    const shell = createMirageShellAdapter(ws);
    await expect(
      shell.exec('whatever', {
        cwd: '/',
      }),
    ).rejects.toThrow('workspace blew up');
  });
});
