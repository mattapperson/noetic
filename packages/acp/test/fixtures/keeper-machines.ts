/**
 * The machines the keeper tests run their agent on: this one, a WebSocket
 * runner, or a runner started over stdio (as ssh or docker exec would).
 */

import { fileURLToPath } from 'node:url';
import type { AcpMachineFactory } from '@noetic-tools/types';
import { commandMachine, webSocketMachine } from '../../src/remote';

const BIN = fileURLToPath(new URL('../../src/bin.ts', import.meta.url));

export type MachineKind = 'local' | 'ws' | 'stdio';

export function machineFor(kind: string): AcpMachineFactory | undefined {
  if (kind === 'ws') {
    return webSocketMachine({
      url: process.env.NOETIC_TEST_RUNNER_URL ?? '',
      token: process.env.NOETIC_TEST_RUNNER_TOKEN ?? '',
    });
  }
  if (kind === 'stdio') {
    return commandMachine({
      command: process.execPath,
      args: [
        BIN,
        'serve',
        '--stdio',
      ],
    });
  }
  return undefined;
}
