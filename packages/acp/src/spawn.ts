/**
 * Start a process on an agent's machine and hold its stdio — the seam a stdio
 * MCP server that depends on that machine is started through, with Noetic
 * still its MCP client on the host.
 */

import type { AcpMachineFactory, AcpTransport, Spawn, SpawnCommand } from '@noetic-tools/types';

/**
 * Each call opens the machine, starts `command` there, and releases the
 * machine when the process's stream closes.
 * @public
 */
export function spawnOn(machine: AcpMachineFactory, signal?: AbortSignal): Spawn {
  return async (command: SpawnCommand): Promise<AcpTransport> => {
    const opened = await machine({
      signal,
    });
    let process: AcpTransport;
    try {
      process = await opened.spawn(command);
    } catch (e) {
      await opened.close().catch(() => undefined);
      throw e;
    }
    return {
      readable: process.readable,
      writable: process.writable,
      async close() {
        try {
          await process.close();
        } finally {
          await opened.close();
        }
      },
    };
  };
}
