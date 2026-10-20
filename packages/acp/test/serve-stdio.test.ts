/**
 * `serveAcp` over REAL process stdio: a spawned child fixture serves a stub
 * harness on its own stdin/stdout (the shape an editor launches), driven by
 * Noetic's ACP client through the `./stdio` transport. Covers the
 * `@noetic-tools/acp/server` binding, the handshake, a full prompt round
 * trip, and clean shutdown when the client disconnects.
 */

import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { openAcpConnection } from '../src/connection';
import { stdioAcpTransport } from '../src/stdio';
import { MemoryFs, RecordingShell } from './_helpers';

const FIXTURE = fileURLToPath(new URL('./fixtures/serve-stdio-agent.ts', import.meta.url));

describe('serveAcp over process stdio', () => {
  it('serves a prompt round trip and shuts down when the client disconnects', async () => {
    const transport = await stdioAcpTransport({
      agentId: 'stdio-stub',
      command: 'bun',
      args: [
        FIXTURE,
      ],
    })({
      cwd: '/tmp',
    });

    const connection = await openAcpConnection({
      agentId: 'stdio-stub',
      transport,
      host: {
        cwd: '/tmp',
        fs: new MemoryFs(),
        shell: new RecordingShell(),
        threadId: 'stdio-client',
        onSessionUpdate: () => undefined,
      },
    });

    expect(connection.protocolVersion).toBe(1);
    expect(connection.agentCapabilities.loadSession).toBe(false);
    expect(connection.agentCapabilities.promptCapabilities?.image).toBe(true);
    expect(connection.agentCapabilities.promptCapabilities?.embeddedContext).toBe(true);
    expect(connection.authMethods).toEqual([]);

    const session = await connection.newSession({
      cwd: '/tmp',
    });
    const result = await session.prompt({
      content: [
        {
          type: 'text',
          text: 'say hello',
        },
      ],
    });
    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toBe('hello over stdio');

    // Disconnecting ends the child's stdin; the fixture awaits `closed` and
    // exits. A hung child would keep the transport (and this test) alive —
    // completing within the timeout IS the shutdown assertion.
    await connection.close();
  }, 15_000);
});
