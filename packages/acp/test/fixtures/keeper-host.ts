/**
 * Child-process fixture: a host that starts the keeper agent, starts a turn,
 * prints `{ handle, sessionId }` once the agent first speaks, and then waits
 * to be killed — a host that dies mid-turn.
 *
 * argv: whenHostExits ('keep' | 'stop'), prompt text, machine ('local' |
 * 'ws' | 'stdio'). A 'ws' runner's URL and token come from
 * NOETIC_TEST_RUNNER_URL and NOETIC_TEST_RUNNER_TOKEN.
 */

import { fileURLToPath } from 'node:url';
import type { AcpClientHost, AcpWhenHostExits } from '@noetic-tools/types';
import { customAcpAgent } from '../../src/agents';
import { MemoryFs, RecordingShell } from '../_helpers';
import { machineFor } from './keeper-machines';

const whenHostExits: AcpWhenHostExits = process.argv[2] === 'stop' ? 'stop' : 'keep';
const promptText = process.argv[3] ?? 'ask';
const agentScript = fileURLToPath(new URL('./keeper-agent.ts', import.meta.url));

const agent = customAcpAgent({
  agentId: 'kept',
  command: process.execPath,
  args: [
    agentScript,
  ],
  machine: machineFor(process.argv[4] ?? 'local'),
});
let announced = false;
let announce: () => void = () => undefined;
const host: AcpClientHost = {
  cwd: process.cwd(),
  threadId: 'first-host',
  fs: new MemoryFs(),
  shell: new RecordingShell(),
  permissions: {
    default: 'allow',
  },
  onSessionUpdate: () => {
    if (!announced) {
      announced = true;
      announce();
    }
  },
};
const connection = await agent.connect({
  host,
  whenHostExits,
});
const session = await connection.newSession({
  cwd: process.cwd(),
});
announce = () => {
  process.stdout.write(
    `${JSON.stringify({
      handle: connection.reattach,
      sessionId: session.sessionId,
    })}\n`,
  );
};
// The permission request is left unanswered by this host: it dies first.
host.permissions = undefined;
host.onPermissionRequest = () => new Promise(() => undefined);
void session.prompt({
  content: [
    {
      type: 'text',
      text: promptText,
    },
  ],
});
setInterval(() => undefined, 1e3);
