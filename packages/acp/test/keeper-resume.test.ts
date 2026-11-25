/**
 * The whole path with real processes: a durable run's host dies while its ACP
 * agent waits on a permission request; a new host resumes the run, reattaches
 * to the same agent through its keeper, answers the request, and gets the
 * turn — the part the first host saw included — as the step's output.
 */

import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHarness, step } from '@noetic-tools/core';
import { customAcpAgent } from '../src/agents';
import { LineSplitter } from '../src/keeper/protocol';
import { fileStorage } from './fixtures/file-storage';

const POSIX = process.platform !== 'win32';
const HOST = fileURLToPath(new URL('./fixtures/keeper-durable-host.ts', import.meta.url));
const AGENT = fileURLToPath(new URL('./fixtures/keeper-agent.ts', import.meta.url));

/** Whether the run's ACP session record, with its reattach handle, is stored. */
function recordStored(dir: string): boolean {
  return readdirSync(dir).some((name) => {
    if (!decodeURIComponent(name).includes('acp-session')) {
      return false;
    }
    return readFileSync(join(dir, name), 'utf8').includes('noetic-acp-keeper');
  });
}

describe.skipIf(!POSIX)('a durable run whose host dies mid-turn', () => {
  it('resumes on a new host by reattaching to the agent that kept working', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-kept-run-'));
    try {
      const first = spawn(
        process.execPath,
        [
          HOST,
          dir,
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
      const executionId = await new Promise<string>((resolve) => {
        first.stdout?.on('data', (chunk: Buffer) => {
          const [id] = splitter.push(chunk);
          if (id !== undefined) {
            resolve(id);
          }
        });
      });
      for (let i = 0; i < 200 && !recordStored(dir); i += 1) {
        await Bun.sleep(25);
      }
      expect(recordStored(dir)).toBe(true);
      // Let the agent reach its permission request, then crash the host.
      await Bun.sleep(300);
      const exited = new Promise((resolve) => first.once('exit', resolve));
      first.kill('SIGKILL');
      await exited;

      const harness = new AgentHarness({
        name: 'kept-run',
        params: {},
        environment: {
          storage: {
            adapter: fileStorage(dir),
          },
        },
      });
      const ctx = await harness.restore(executionId);
      expect(ctx).toBeDefined();
      if (!ctx) {
        return;
      }
      const output = await harness.run(
        step.acpAgent({
          id: 'code',
          agent: customAcpAgent({
            agentId: 'kept',
            command: process.execPath,
            args: [
              AGENT,
            ],
            env: {
              KEEPER_AGENT_PIDS: `${dir}.pids`,
            },
          }),
          prompt: 'ask',
          tools: [],
          permissions: {
            default: 'allow',
          },
        }),
        undefined,
        ctx,
      );

      // "one " went to the dead host; "two" came after this host allowed the
      // request the agent had been waiting on all along.
      expect(output).toBe('one two');
      // One agent process served both hosts: nothing was started again.
      expect(readFileSync(`${dir}.pids`, 'utf8').trim().split('\n')).toHaveLength(1);
      await harness.close();
    } finally {
      rmSync(dir, {
        recursive: true,
        force: true,
      });
      rmSync(`${dir}.pids`, {
        force: true,
      });
    }
  }, 30e3);
});
