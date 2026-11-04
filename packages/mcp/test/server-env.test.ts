/**
 * A stdio MCP server sees the same environment however it starts: as a local
 * subprocess of the MCP SDK's client (a `callModel` step's server), or through
 * an ACP agent's machine — this one, or a runner — beside the agent.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { Spawn } from '@noetic-tools/types';
import { z } from 'zod';
import type { AcpRunnerListener } from '../../acp/src/remote';
import { listenAcpRunner, webSocketMachine } from '../../acp/src/remote';
import { spawnOn } from '../../acp/src/spawn';
import { localMachine } from '../../acp/src/stdio';
import { mcp } from '../src/provider';
import { connectOptions } from './_helpers';

const SERVER = join(import.meta.dir, 'fixtures', 'env-server.ts');
const TOKEN = 'server-env-test-token-0123456789';
const HOST_SECRET = 'NOETIC_SERVER_ENV_TEST_SECRET';

const ResultSchema = z.object({
  output: z.object({
    content: z.array(
      z.object({
        text: z.string(),
      }),
    ),
  }),
});

/** The environment the env server reports when started through `spawn`, or locally without it. */
async function serverEnvThrough(spawn: Spawn | undefined): Promise<Record<string, string>> {
  const provider = mcp({
    name: 'env',
    command: process.execPath,
    args: [
      SERVER,
    ],
    env: [
      {
        name: 'SERVER_SETTING',
        value: 'on',
      },
    ],
    ...(spawn
      ? {
          spawn,
        }
      : {}),
  });
  const [connection] = await provider.connect(connectOptions('env'));
  if (!connection) {
    throw new Error('no connection');
  }
  try {
    const result = ResultSchema.parse(
      await connection.call(
        'env',
        {},
        {
          signal: new AbortController().signal,
          idempotencyKey: crypto.randomUUID(),
        },
      ),
    );
    return z
      .record(z.string(), z.string())
      .parse(JSON.parse(result.output.content[0]?.text ?? '{}'));
  } finally {
    await connection.release();
  }
}

describe('the environment a stdio MCP server starts with', () => {
  let listener: AcpRunnerListener;
  beforeAll(async () => {
    process.env[HOST_SECRET] = 'sk-host-only';
    listener = await listenAcpRunner({
      token: TOKEN,
    });
  });
  afterAll(async () => {
    delete process.env[HOST_SECRET];
    await listener.close();
  });

  it('is the same locally, through this machine and through a runner, and holds none of the host’s secrets', async () => {
    const local = await serverEnvThrough(undefined);
    const machine = await serverEnvThrough(spawnOn(localMachine()));
    const runner = await serverEnvThrough(
      spawnOn(
        webSocketMachine({
          url: listener.url,
          token: TOKEN,
        }),
      ),
    );
    expect(local.SERVER_SETTING).toBe('on');
    expect(local[HOST_SECRET]).toBeUndefined();
    expect(machine).toEqual(local);
    expect(runner).toEqual(local);
  });
});
