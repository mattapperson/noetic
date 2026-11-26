/**
 * Child-process fixture: a durable harness whose ACP step runs the keeper
 * agent and leaves its permission request unanswered. Prints the execution id,
 * then waits to be killed.
 *
 * argv: storage directory.
 */

import { fileURLToPath } from 'node:url';
import { AgentHarness, step } from '@noetic-tools/core';
import { createLocalSubprocessAdapter } from '../../../platform-node/src/local-subprocess-adapter';
import { customAcpAgent } from '../../src/agents';
import { fileStorage } from './file-storage';

const dir = process.argv[2];
if (!dir) {
  throw new Error('a storage directory is required');
}
const harness = new AgentHarness({
  name: 'kept-run',
  params: {},
  environment: {
    storage: {
      adapter: fileStorage(dir),
    },
    subprocess: createLocalSubprocessAdapter(),
  },
});
const ctx = harness.createContext();
process.stdout.write(`${ctx.id}\n`);
void harness.run(
  step.acpAgent({
    id: 'code',
    agent: customAcpAgent({
      agentId: 'kept',
      command: process.execPath,
      args: [
        fileURLToPath(new URL('./keeper-agent.ts', import.meta.url)),
      ],
      env: {
        KEEPER_AGENT_PIDS: `${dir}.pids`,
      },
    }),
    prompt: 'ask',
    tools: [],
    // Never answered: this host dies first.
    onPermissionRequest: () => new Promise(() => undefined),
  }),
  undefined,
  ctx,
);
setInterval(() => undefined, 1e3);
