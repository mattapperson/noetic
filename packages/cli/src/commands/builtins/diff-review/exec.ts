/**
 * Tiny child-process exec helper.
 *
 * Replaces upstream's `pi.exec(cmd, args, { cwd })` so the ported `git.ts`
 * can keep the same "allow failure" pattern: we never throw, we always
 * return `{ code, stdout, stderr }` and let callers decide how to react.
 */

import { spawn } from 'node:child_process';

//#region Types

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd: string;
}

//#endregion

//#region Public API

export async function exec(
  command: string,
  args: ReadonlyArray<string>,
  options: ExecOptions,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const child = spawn(command, Array.from(args), {
      cwd: options.cwd,
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const pushChunk = (target: Buffer[], chunk: unknown): void => {
      // Without an encoding set, Node delivers Buffer chunks. The guard makes
      // that explicit and copes with future @types/node changes that widen
      // the listener signature to `unknown`.
      if (Buffer.isBuffer(chunk)) {
        target.push(chunk);
        return;
      }
      target.push(Buffer.from(String(chunk)));
    };

    child.stdout.on('data', (chunk) => {
      pushChunk(stdoutChunks, chunk);
    });
    child.stderr.on('data', (chunk) => {
      pushChunk(stderrChunks, chunk);
    });

    const finish = (code: number): void => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    };

    child.on('error', (err) => {
      stderrChunks.push(Buffer.from(err.message));
      finish(127);
    });
    child.on('close', (code) => {
      finish(typeof code === 'number' ? code : 1);
    });
  });
}

//#endregion
