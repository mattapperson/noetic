/**
 * Live, opt-in: the real Claude Code and Codex bridges keep serving noetic
 * tools after their host is killed and a new host reattaches. The new host
 * serves the bridge again under the same address and token, so the agent's
 * MCP client must reconnect to it (its old MCP session is gone) for the call
 * to reach the new host.
 *
 * Runs real model turns. Needs the agent CLIs logged in and network access:
 *   ACP_LIVE_AGENT=1 bun test test/live-reattach.test.ts
 * `ACP_LIVE_AGENTS=codex` (comma-separated) picks the bridges; both by default.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LineSplitter } from '../src/keeper/protocol';
import type { LiveAgentId } from './fixtures/live-agents';
import { askToEcho, connectLive, echoHost, isLiveAgentId } from './fixtures/live-agents';

const LIVE = process.env.ACP_LIVE_AGENT === '1' && process.platform !== 'win32';
const HOST = fileURLToPath(new URL('./fixtures/live-host.ts', import.meta.url));
const AGENTS: LiveAgentId[] = (process.env.ACP_LIVE_AGENTS ?? 'claude-code,codex')
  .split(',')
  .map((id) => id.trim())
  .filter(isLiveAgentId);

const FirstHostSchema = z.object({
  handle: z.record(z.string(), z.unknown()),
  sessionId: z.string(),
  calls: z.array(z.string()),
  text: z.string(),
});

/** Run the first host until its agent has made a call, then kill it as a crash would. */
async function firstHostThenCrash(
  id: LiveAgentId,
  cwd: string,
): Promise<z.infer<typeof FirstHostSchema>> {
  const host = spawn(
    process.execPath,
    [
      HOST,
      id,
      cwd,
    ],
    {
      stdio: [
        'ignore',
        'pipe',
        'inherit',
      ],
    },
  );
  const splitter = new LineSplitter();
  const line = await new Promise<string>((resolve, reject) => {
    host.stdout?.on('data', (chunk: Buffer) => {
      const [first] = splitter.push(chunk);
      if (first !== undefined) {
        resolve(first);
      }
    });
    host.once('exit', (code) => reject(new Error(`The first host exited (${code}).`)));
  });
  const exited = new Promise((resolve) => host.once('exit', resolve));
  host.kill('SIGKILL');
  await exited;
  return FirstHostSchema.parse(JSON.parse(line));
}

describe.skipIf(!LIVE)('live: a real bridge after its host is killed', () => {
  for (const id of AGENTS) {
    it(`${id} reaches the new host's tools after a reattach`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'noetic-live-reattach-'));
      try {
        const first = await firstHostThenCrash(id, cwd);
        expect(first.calls).toEqual([
          'first',
        ]);
        expect(first.text).toContain('echo[host1]:first');

        const calls: string[] = [];
        const connection = await connectLive(id, {
          host: echoHost('host2', calls, cwd),
          reattach: first.handle,
        });
        try {
          assert(connection.attachSession);
          const session = await connection.attachSession(first.sessionId);
          assert(session.resumeTurn);
          // The keeper holds the first answer through attachment.
          expect((await session.resumeTurn({}))?.text).toContain('echo[host1]:first');
          const second = await session.prompt({
            content: [
              {
                type: 'text',
                text: askToEcho('second'),
              },
            ],
          });
          expect(calls).toContain('second');
          expect(second.text).toContain('echo[host2]:second');
        } finally {
          await connection.close();
        }
      } finally {
        rmSync(cwd, {
          recursive: true,
          force: true,
        });
      }
    }, 240e3);
  }
});
