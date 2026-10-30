import { describe, expect, test } from 'bun:test';
import type { Item } from '@noetic-tools/types';
import { CONNECTION_EVENT_ITEM_TYPE, isNoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import { WITHHELD_BLOB_TEXT, withholdSensitiveBlobs } from '../../src/connections/blobs';
import { createInMemoryConnection } from '../../src/connections/in-memory-connection';
import type { ConnectionRuntime } from '../../src/connections/registry';
import { defineSource } from '../../src/connections/sources';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryArtifactStore } from '../../src/runtime/in-memory-artifact-store';
import { harnessInternal } from '../../src/util/harness-internals';
import { sleep } from '../_helpers';

function registryOf(harness: object): ConnectionRuntime | undefined {
  return harnessInternal<ConnectionRuntime>(harness, 'connectionRegistry');
}

//#region Helpers

async function text(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return '';
  }
  return new Response(stream).text();
}

function bytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

async function until(predicate: () => boolean, ms = 1e3): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting');
    }
    await sleep(2);
  }
}

//#endregion

describe('createInMemoryArtifactStore', () => {
  test('content-addressed: identical content is stored once and read back', async () => {
    const store = createInMemoryArtifactStore();
    const a = await store.put(bytes('hello'), {
      mimeType: 'text/plain',
    });
    const b = await store.put(
      new Response('hello').body ??
        new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        }),
      {
        mimeType: 'text/markdown',
      },
    );
    expect(a).toEqual(b);
    expect(a.$blob.uri).toBe(`artifact://sha256/${a.$blob.sha256}`);
    expect(a.$blob.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(a.$blob.bytes).toBe(5);
    expect(await text(await store.get(a.$blob.uri))).toBe('hello');
    expect(await store.head(a.$blob.uri)).toEqual(a.$blob);
    expect(await store.get('artifact://sha256/none')).toBeNull();
    expect(await store.head('artifact://sha256/none')).toBeNull();
  });

  test('attach links blobs to a run; clearRun removes content no run links to', async () => {
    const store = createInMemoryArtifactStore();
    const blob = await store.put(bytes('x'), {
      mimeType: 'text/plain',
      name: 'x.txt',
      sensitive: true,
    });
    await store.attach(blob.$blob.uri, {
      executionId: 'r1',
      source: 'browser',
    });
    await store.attach(blob.$blob.uri, {
      executionId: 'r1',
      pinned: true,
    });
    await store.attach(blob.$blob.uri, {
      executionId: 'r2',
    });
    await store.attach('artifact://sha256/missing', {
      executionId: 'r1',
    });
    const [record] = await store.listRun('r1');
    expect(record).toMatchObject({
      executionId: 'r1',
      source: 'browser',
      name: 'x.txt',
      sensitive: true,
      pinned: true,
      state: 'stored',
    });
    await store.clearRun('r1');
    expect(await store.listRun('r1')).toEqual([]);
    expect(await store.head(blob.$blob.uri)).not.toBeNull();
    await store.clearRun('r2');
    expect(await store.head(blob.$blob.uri)).toBeNull();
  });

  test('a run over its count cap drops the oldest unpinned blob and records it', async () => {
    const store = createInMemoryArtifactStore({
      retention: {
        maxCountPerRun: 2,
      },
    });
    const uris: string[] = [];
    for (const content of [
      'one',
      'two',
      'three',
    ]) {
      const blob = await store.put(bytes(content), {
        mimeType: 'text/plain',
      });
      uris.push(blob.$blob.uri);
      await store.attach(blob.$blob.uri, {
        executionId: 'r',
      });
    }
    const records = await store.listRun('r');
    expect(records.map((r) => r.state)).toEqual([
      'dropped',
      'stored',
      'stored',
    ]);
    expect(await store.head(uris[0] ?? '')).toBeNull();
  });

  test('pinned blobs are kept past a byte cap and the overage is reported', async () => {
    const store = createInMemoryArtifactStore({
      retention: {
        maxBytesPerRun: 4,
      },
    });
    const first = await store.put(bytes('aaaa'), {
      mimeType: 'text/plain',
    });
    await store.attach(first.$blob.uri, {
      executionId: 'r',
      pinned: true,
    });
    const second = await store.put(bytes('bbbb'), {
      mimeType: 'text/plain',
    });
    await store.attach(second.$blob.uri, {
      executionId: 'r',
      pinned: true,
    });
    const records = await store.listRun('r');
    expect(records.map((r) => r.state)).toEqual([
      'stored',
      'stored',
    ]);
    expect(records[1]?.overCap).toBe(true);
  });

  test('ttlMs expires unpinned blobs', async () => {
    let now = 0;
    const store = createInMemoryArtifactStore({
      retention: {
        ttlMs: 10,
      },
      now: () => now,
    });
    const blob = await store.put(bytes('t'), {
      mimeType: 'text/plain',
    });
    await store.attach(blob.$blob.uri, {
      executionId: 'r',
    });
    now = 11;
    expect((await store.listRun('r'))[0]?.state).toBe('dropped');
  });
});

describe('AgentHarness connections', () => {
  test('construction validates connections and triggers', () => {
    const cases: ReadonlyArray<
      readonly [
        string,
        () => unknown,
      ]
    > = [
      [
        'CONNECTION_INVALID',
        () =>
          new AgentHarness({
            name: 'a',
            params: {},
            connections: {
              'bad name': createInMemoryConnection(),
            },
          }),
      ],
      [
        'CONNECTION_UNKNOWN',
        () =>
          new AgentHarness({
            name: 'a',
            params: {},
            triggers: [
              {
                id: 't',
                connection: 'slack',
                event: 'chat.message.created',
                input: () => '',
              },
            ],
          }),
      ],
    ];
    for (const [code, make] of cases) {
      let caught: unknown;
      try {
        make();
      } catch (e) {
        caught = e;
      }
      expect(isNoeticConfigError(caught) && caught.code).toBe(code);
    }
  });

  test('start() connects providers; status, artifacts and tools reach the harness', async () => {
    const phone = createInMemoryConnection({
      operations: {
        ping: {
          run: () => 'pong',
        },
      },
    });
    const artifacts = createInMemoryArtifactStore();
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone,
      },
      environment: {
        artifacts,
      },
    });
    expect(harness.getConnectionStatus()).toEqual([
      {
        name: 'phone',
        state: 'connecting',
      },
    ]);
    await harness.start();
    await harness.start();
    expect(phone.connects).toBe(1);
    expect(harness.getConnectionStatus('phone')[0]?.state).toBe('ready');
    expect(harness.artifacts).toBe(artifacts);
    const blob = await artifacts.put(new TextEncoder().encode('x'), {
      mimeType: 'text/plain',
    });
    await artifacts.attach(blob.$blob.uri, {
      executionId: 'run-1',
    });
    expect(await harness.artifacts.listRun('run-1')).toHaveLength(1);
    expect(registryOf(harness)?.names()).toEqual([
      'phone',
    ]);
    await harness.close();
    expect(harness.getConnectionStatus('phone')[0]?.state).toBe('closed');
  });

  test('a harness without connections has none, and an in-memory artifact store', async () => {
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
    });
    await harness.start();
    expect(harness.getConnectionStatus()).toEqual([]);
    expect(registryOf(harness)).toBeUndefined();
    expect(await harness.artifacts.listRun('x')).toEqual([]);
    expect(await harness.restore('missing')).toBeNull();
  });

  test('run() starts connections and offers their tools to the step', async () => {
    const phone = createInMemoryConnection({
      operations: {
        ping: {
          run: () => 'pong',
        },
      },
    });
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        phone,
      },
    });
    const ctx = harness.createContext();
    const names = await harness.run(
      {
        kind: 'runCode',
        id: 'probe',
        execute: async (_input: string, c) => (c.unifiedTools ?? []).map((t) => t.name),
      },
      'x',
      ctx,
    );
    expect(names).toContain('phone_ping');
    expect(ctx.layers?.some((l) => l.id === 'noetic/connection-view/phone')).toBe(true);
    await harness.close();
  });

  test('a trigger turns a source event into a turn carrying the event item', async () => {
    const deploys = defineSource({
      events: {
        'deploy.failed': z.object({
          service: z.string(),
        }),
      },
    });
    const seen: Item[][] = [];
    const harness = new AgentHarness({
      name: 'agent',
      params: {},
      connections: {
        deploys,
      },
      triggers: [
        {
          id: 'failures',
          connection: 'deploys',
          event: 'deploy.failed',
          input: (e) => `failed: ${JSON.stringify(e.payload)}`,
        },
      ],
      agentGraph: {
        kind: 'runCode',
        id: 'record',
        execute: async (_input, ctx) => {
          seen.push([
            ...ctx.itemLog.items,
          ]);
          return 'done';
        },
      },
    });
    await harness.start();
    await sleep(5);
    await deploys.emit({
      type: 'deploy.failed',
      id: 'd1',
      payload: {
        service: 'api',
      },
    });
    await until(() => seen.length === 1);
    const items = seen[0] ?? [];
    expect(items.some((i) => i.type === CONNECTION_EVENT_ITEM_TYPE)).toBe(true);
    expect(JSON.stringify(items)).toContain('failed: {\\"service\\":\\"api\\"}');
    await harness.close();
  });
});

describe('sensitive blobs', () => {
  test('are withheld from anything the model sees; other blobs pass through', async () => {
    const artifacts = createInMemoryArtifactStore();
    const session = await artifacts.put(bytes('cookie=secret'), {
      mimeType: 'application/json',
      sensitive: true,
    });
    const shot = await artifacts.put(bytes('png'), {
      mimeType: 'image/png',
    });
    expect((await artifacts.head(session.$blob.uri))?.sensitive).toBe(true);
    expect(
      await withholdSensitiveBlobs(
        {
          session,
          shot,
        },
        artifacts,
      ),
    ).toEqual({
      session: WITHHELD_BLOB_TEXT,
      shot,
    });
    expect(await withholdSensitiveBlobs(shot, artifacts)).toBe(shot);
  });
});
