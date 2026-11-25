/**
 * Child-process fixture: an ACP agent for the keeper tests. On a prompt it
 * says "one ", then — by the prompt's text — asks permission (`ask`) or
 * waits a moment (`slow`), and says "two" before it ends the turn.
 */

import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { frameworkCast } from '@noetic-tools/types';

// Tests that must tell one agent process from another list every pid here.
if (process.env.KEEPER_AGENT_PIDS) {
  appendFileSync(process.env.KEEPER_AGENT_PIDS, `${process.pid}\n`);
}

function say(conn: AgentSideConnection, sessionId: string, text: string): Promise<void> {
  return conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text,
      },
    },
  });
}

new AgentSideConnection(
  (conn) => ({
    async initialize() {
      return {
        protocolVersion: 1,
        agentCapabilities: {},
      };
    },
    async newSession() {
      return {
        sessionId: 'kept-session',
        modes: {
          currentModeId: 'auto',
          availableModes: [
            {
              id: 'auto',
              name: 'Auto',
            },
            {
              id: 'read-only',
              name: 'Read only',
            },
          ],
        },
      };
    },
    async authenticate() {},
    async cancel() {},
    async setSessionMode() {
      return {};
    },
    async prompt(params) {
      const text = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('');
      await say(conn, params.sessionId, 'one ');
      if (text.includes('ask')) {
        const answer = await conn.requestPermission({
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: 'call-1',
            title: 'Write the file',
            kind: 'edit',
          },
          options: [
            {
              optionId: 'allow',
              name: 'Allow',
              kind: 'allow_once',
            },
            {
              optionId: 'deny',
              name: 'Deny',
              kind: 'reject_once',
            },
          ],
        });
        const allowed =
          answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'allow';
        await say(conn, params.sessionId, allowed ? 'two' : 'denied');
      }
      if (text.includes('slow')) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        await say(conn, params.sessionId, 'two');
      }
      return {
        stopReason: 'end_turn',
      };
    },
  }),
  ndJsonStream(
    frameworkCast<WritableStream<Uint8Array>>(Writable.toWeb(process.stdout)),
    frameworkCast<ReadableStream<Uint8Array>>(Readable.toWeb(process.stdin)),
  ),
);
