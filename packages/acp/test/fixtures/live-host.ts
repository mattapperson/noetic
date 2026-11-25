/**
 * Child-process fixture for the live reattach test: a first host that starts a
 * real agent, has it call `echo` through the bridge once, prints what the test
 * needs to reattach, and waits to be killed.
 *
 * argv: agent id ('claude-code' | 'codex'), working directory.
 */

import { askToEcho, echoHost, isLiveAgentId, liveAgent } from './live-agents';

const id = process.argv[2] ?? '';
const cwd = process.argv[3] ?? process.cwd();
if (!isLiveAgentId(id)) {
  throw new Error(`unknown live agent '${id}'`);
}
const calls: string[] = [];
const connection = await liveAgent(id).connect({
  host: echoHost('host1', calls, cwd),
});
const session = await connection.newSession({
  cwd,
});
const first = await session.prompt({
  content: [
    {
      type: 'text',
      text: askToEcho('first'),
    },
  ],
});
process.stdout.write(
  `${JSON.stringify({
    handle: connection.reattach,
    sessionId: session.sessionId,
    calls,
    text: first.text,
  })}\n`,
);
setInterval(() => undefined, 1e3);
