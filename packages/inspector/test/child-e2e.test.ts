/**
 * Integration: boots the real agent child (fresh Bun process, like the host
 * does) against a stub-model agent, runs a chat turn with no network, and
 * verifies the session survives a "hot reload" — a second child seeded from
 * the first one's persisted item log.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Item } from '@noetic-tools/core';
import type { Subprocess } from 'bun';

const PKG_DIR = path.resolve(import.meta.dir, '..');
// Inside the package so the stub agent can resolve @noetic-tools/core.
const SCRATCH = path.join(import.meta.dir, '.e2e-scratch');
const PORT = 4790;
const BASE = `http://localhost:${PORT}`;

const STUB_AGENT = `
import type { StorageAdapter, TraceExporter } from '@noetic-tools/core';
import { AgentHarness, callModel, scratchpad } from '@noetic-tools/core';

export function createAgent(deps: { storage: StorageAdapter; traceExporter: TraceExporter }): {
  harness: AgentHarness;
} {
  const harness = new AgentHarness({
    name: 'stub-agent',
    agentGraph: callModel({ id: 'chat', model: 'stub/model' }),
    params: {},
    environment: { storage: { adapter: deps.storage } },
    traceExporter: deps.traceExporter,
    contextLayers: [scratchpad()],
    _testCallModel: async () => ({
      items: [
        {
          id: \`asst-\${crypto.randomUUID()}\`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'stub reply' }],
        },
      ],
      usage: { inputTokens: 5, outputTokens: 3 },
    }),
  });
  return { harness };
}
`;

function spawnChild(): Subprocess {
  return Bun.spawn(
    [
      'bun',
      path.join(PKG_DIR, 'server', 'child.ts'),
    ],
    {
      cwd: PKG_DIR,
      env: {
        ...process.env,
        INSPECTOR_AGENT_FILE: path.join(SCRATCH, 'agent.ts'),
        INSPECTOR_DATA_DIR: SCRATCH,
        INSPECTOR_THREAD_ID: 'e2e-thread',
        INSPECTOR_CHILD_PORT: String(PORT),
      },
      stdout: 'ignore',
      stderr: 'inherit',
    },
  );
}

async function waitHealthy(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${BASE}/status`);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(100);
  }
  throw new Error('child never became healthy');
}

async function waitForHistory(minItems: number): Promise<Item[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(`${BASE}/history`);
    const body: {
      items: Item[];
    } = await response.json();
    if (body.items.length >= minItems) {
      return body.items;
    }
    await Bun.sleep(100);
  }
  throw new Error(`history never reached ${minItems} items`);
}

async function stopChild(child: Subprocess): Promise<void> {
  child.kill('SIGTERM');
  await child.exited;
}

describe('agent child end-to-end', () => {
  let child: Subprocess;

  beforeAll(async () => {
    rmSync(SCRATCH, {
      recursive: true,
      force: true,
    });
    mkdirSync(SCRATCH, {
      recursive: true,
    });
    await writeFile(path.join(SCRATCH, 'agent.ts'), STUB_AGENT);
    child = spawnChild();
    await waitHealthy();
  });

  afterAll(async () => {
    await stopChild(child);
    rmSync(SCRATCH, {
      recursive: true,
      force: true,
    });
  });

  it('lists the layer roster', async () => {
    const layers: Array<{
      id: string;
    }> = await (await fetch(`${BASE}/layers`)).json();
    expect(layers.map((layer) => layer.id)).toEqual([
      'scratchpad',
    ]);
  });

  it('runs a chat turn against the stub model and persists user + assistant items', async () => {
    const response = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: 'hello agent',
        messageId: 'msg-e2e-1',
      }),
    });
    expect(response.status).toBe(202);

    const items = await waitForHistory(2);
    const kinds = items.map((item) =>
      item.type === 'message' ? `${item.type}:${item.role}` : item.type,
    );
    expect(kinds).toContain('message:user');
    expect(kinds).toContain('message:assistant');
  });

  it('serves a next-turn preview once idle', async () => {
    const response = await fetch(`${BASE}/preview`);
    expect(response.status).toBe(200);
    const body: {
      items: Item[];
    } = await response.json();
    expect(body.items.length).toBeGreaterThanOrEqual(2);
  });

  it('a fresh child (hot reload) seeds the same conversation from disk', async () => {
    const before = await waitForHistory(2);
    await stopChild(child);

    child = spawnChild();
    await waitHealthy();

    const after = await waitForHistory(2);
    expect(after).toEqual(before);

    // And the restored session keeps working: a second turn extends it.
    await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: 'still there?',
        messageId: 'msg-e2e-2',
      }),
    });
    const extended = await waitForHistory(before.length + 2);
    expect(extended.length).toBeGreaterThanOrEqual(before.length + 2);
  });
});
