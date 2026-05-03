import type { ShellAdapter, ShellExecResult } from '../types/shell-adapter';

//#region Public API

/**
 * @public Create a portable shell adapter that does not execute host processes.
 *
 * This is the runtime default for portable harnesses. Hosts that want real
 * process execution should pass an explicit local, Worker, container, or
 * just-bash-backed adapter.
 */
export function createInMemoryShellAdapter(): ShellAdapter {
  return {
    async exec(command, _options): Promise<ShellExecResult> {
      return {
        stdout: '',
        stderr: `Shell execution is not available in the default in-memory adapter: ${command}`,
        exitCode: 127,
      };
    },
  };
}

//#endregion
