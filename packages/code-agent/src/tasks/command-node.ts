import type { ShellAdapter } from '@noetic/core';
import type { TaskCommandAdapter } from './command.js';

export interface NodeTaskCommandAdapterOptions {
  shell: ShellAdapter;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function createNodeTaskCommandAdapter(
  options: NodeTaskCommandAdapterOptions,
): TaskCommandAdapter {
  return {
    async run(request) {
      const result = await options.shell.exec(
        [
          request.command,
          ...(request.args ?? []).map(shellQuote),
        ].join(' '),
        {
          cwd: request.cwd,
          timeout: request.timeoutMs === undefined ? undefined : request.timeoutMs / 1000,
        },
      );
      return {
        kind: 'completed',
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  };
}
