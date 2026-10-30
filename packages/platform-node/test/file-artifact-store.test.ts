/**
 * File Artifact Store (spec 25 § File Artifact Store, spec 08 § Artifact
 * Store): content addressing, the on-disk layout, per-run retention with
 * pinning and overage, TTL, shared content across runs, and clearRun.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyRetention, createFileArtifactStore } from '../src/file-artifact-store';

//#region Helpers

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'noetic-artifacts-'));
});

afterEach(() => {
  rmSync(dir, {
    recursive: true,
    force: true,
  });
});

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function blobPath(hex: string): string {
  return path.join(dir, 'sha256', hex.slice(0, 2), hex);
}

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  expect(stream).not.toBeNull();
  if (!stream) {
    return '';
  }
  return new Response(stream).text();
}

function clock(start = 1e6): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

type TestRecord = Parameters<typeof applyRetention>[0]['records'][number];

function record(uri: string, attachedAt: number, extra: Partial<TestRecord> = {}): TestRecord {
  return {
    uri,
    mimeType: 'text/plain',
    bytes: 10,
    sha256: 'a'.repeat(64),
    executionId: 'run',
    pinned: false,
    attachedAt,
    state: 'stored',
    ...extra,
  };
}

//#endregion

describe('createFileArtifactStore — content addressing', () => {
  it('put returns a sha256-addressed BlobRef and writes blob + sidecar', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    const ref = await store.put(bytesOf('hello'), {
      mimeType: 'text/plain',
      name: 'greeting.txt',
    });
    const hex = sha('hello');
    expect(ref.$blob).toEqual({
      uri: `artifact://sha256/${hex}`,
      mimeType: 'text/plain',
      bytes: 5,
      sha256: hex,
    });
    expect(readFileSync(blobPath(hex), 'utf8')).toBe('hello');
    expect(existsSync(`${blobPath(hex)}.json`)).toBe(true);
  });

  it('stores identical content once and get streams it back', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    const a = await store.put(bytesOf('same'), {
      mimeType: 'text/plain',
    });
    const b = await store.put(bytesOf('same'), {
      mimeType: 'application/octet-stream',
    });
    expect(b.$blob).toEqual(a.$blob);
    expect(await readAll(await store.get(a.$blob.uri))).toBe('same');
  });

  it('accepts a ReadableStream and streams large content in chunks', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    const big = 'x'.repeat(200 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytesOf(big.slice(0, 1e5)));
        controller.enqueue(bytesOf(big.slice(1e5)));
        controller.close();
      },
    });
    const ref = await store.put(stream, {
      mimeType: 'text/plain',
    });
    expect(ref.$blob.bytes).toBe(big.length);
    expect(ref.$blob.sha256).toBe(sha(big));
    expect(await readAll(await store.get(ref.$blob.uri))).toBe(big);
  });

  it('get and head return null for unknown or malformed uris', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    const unknown = `artifact://sha256/${'0'.repeat(64)}`;
    expect(await store.get(unknown)).toBeNull();
    expect(await store.head(unknown)).toBeNull();
    expect(await store.get('https://example.com/x')).toBeNull();
    expect(await store.head('artifact://sha256/nothex')).toBeNull();
  });

  it('head returns the body of stored content', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    const ref = await store.put(bytesOf('png'), {
      mimeType: 'image/png',
    });
    expect(await store.head(ref.$blob.uri)).toEqual(ref.$blob);
  });

  it('marks content sensitive once any writer does, and records carry name + sensitive', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    const ref = await store.put(bytesOf('session'), {
      mimeType: 'application/json',
      name: 'session.json',
    });
    await store.put(bytesOf('session'), {
      mimeType: 'application/json',
      sensitive: true,
    });
    expect(await store.head(ref.$blob.uri)).toEqual({
      ...ref.$blob,
      sensitive: true,
    });
    await store.attach(ref.$blob.uri, {
      executionId: 'r1',
      stepPath: 'login',
      source: 'app',
    });
    const [entry] = await store.listRun('r1');
    expect(entry).toMatchObject({
      uri: ref.$blob.uri,
      executionId: 'r1',
      stepPath: 'login',
      source: 'app',
      name: 'session.json',
      sensitive: true,
      pinned: false,
      state: 'stored',
    });
  });

  it('a second put re-stores content whose blob was deleted', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    const ref = await store.put(bytesOf('again'), {
      mimeType: 'text/plain',
    });
    rmSync(blobPath(ref.$blob.sha256));
    expect(await store.head(ref.$blob.uri)).toBeNull();
    await store.put(bytesOf('again'), {
      mimeType: 'text/plain',
    });
    expect(await readAll(await store.get(ref.$blob.uri))).toBe('again');
  });
});

describe('createFileArtifactStore — attach and manifests', () => {
  it('attach writes the run manifest under runs/<executionId>.json', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    const ref = await store.put(bytesOf('a'), {
      mimeType: 'text/plain',
    });
    await store.attach(ref.$blob.uri, {
      executionId: 'exec/1',
    });
    expect(existsSync(path.join(dir, 'runs', `${encodeURIComponent('exec/1')}.json`))).toBe(true);
    expect(await store.listRun('exec/1')).toHaveLength(1);
  });

  it('listRun is empty for an unknown run', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    expect(await store.listRun('nope')).toEqual([]);
  });

  it('attaching the same uri twice keeps one record and makes a pin sticky', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    const ref = await store.put(bytesOf('a'), {
      mimeType: 'text/plain',
    });
    await store.attach(ref.$blob.uri, {
      executionId: 'r',
    });
    await store.attach(ref.$blob.uri, {
      executionId: 'r',
      pinned: true,
    });
    await store.attach(ref.$blob.uri, {
      executionId: 'r',
    });
    const records = await store.listRun('r');
    expect(records).toHaveLength(1);
    expect(records[0]?.pinned).toBe(true);
  });

  it('rejects attaching a malformed uri', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    await expect(
      store.attach('nope', {
        executionId: 'r',
      }),
    ).rejects.toThrow('not an artifact uri');
  });

  it('rejects attaching content that was never stored', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    await expect(
      store.attach(`artifact://sha256/${'1'.repeat(64)}`, {
        executionId: 'r',
      }),
    ).rejects.toThrow('no stored artifact');
  });

  it('rejects a corrupt manifest instead of silently dropping it', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    const ref = await store.put(bytesOf('a'), {
      mimeType: 'text/plain',
    });
    await store.attach(ref.$blob.uri, {
      executionId: 'r',
    });
    writeFileSync(
      path.join(dir, 'runs', 'r.json'),
      JSON.stringify({
        executionId: 'r',
        records: [
          {
            bogus: true,
          },
        ],
      }),
    );
    await expect(store.listRun('r')).rejects.toThrow('corrupt metadata');
  });

  it('survives a new store instance over the same dir', async () => {
    const first = createFileArtifactStore({
      dir,
    });
    const ref = await first.put(bytesOf('persist'), {
      mimeType: 'text/plain',
    });
    await first.attach(ref.$blob.uri, {
      executionId: 'r',
    });
    const second = createFileArtifactStore({
      dir,
    });
    expect(await second.listRun('r')).toHaveLength(1);
    expect(await readAll(await second.get(ref.$blob.uri))).toBe('persist');
  });
});

describe('createFileArtifactStore — retention', () => {
  it('drops the oldest unpinned blob at maxCountPerRun + 1, records it, and deletes unheld content', async () => {
    const time = clock();
    const store = createFileArtifactStore({
      dir,
      now: time.now,
      retention: {
        maxCountPerRun: 2,
      },
    });
    const refs = [];
    for (const text of [
      'one',
      'two',
      'three',
    ]) {
      const ref = await store.put(bytesOf(text), {
        mimeType: 'text/plain',
      });
      refs.push(ref);
      await store.attach(ref.$blob.uri, {
        executionId: 'r',
      });
      time.advance(1);
      const stored = (await store.listRun('r')).filter((r) => r.state === 'stored');
      // N-1 and N fit; N+1 evicts.
      expect(stored.length).toBeLessThanOrEqual(2);
    }
    const records = await store.listRun('r');
    expect(records.map((r) => r.state)).toEqual([
      'dropped',
      'stored',
      'stored',
    ]);
    const [first] = refs;
    expect(first).toBeDefined();
    expect(await store.get(first?.$blob.uri ?? '')).toBeNull();
  });

  it('evicts by bytes and never evicts pinned blobs', async () => {
    const time = clock();
    const store = createFileArtifactStore({
      dir,
      now: time.now,
      retention: {
        maxBytesPerRun: 10,
      },
    });
    const pinned = await store.put(bytesOf('PPPPP'), {
      mimeType: 'text/plain',
    });
    await store.attach(pinned.$blob.uri, {
      executionId: 'r',
      pinned: true,
    });
    time.advance(1);
    const a = await store.put(bytesOf('aaaaa'), {
      mimeType: 'text/plain',
    });
    await store.attach(a.$blob.uri, {
      executionId: 'r',
    });
    time.advance(1);
    const b = await store.put(bytesOf('bbbbb'), {
      mimeType: 'text/plain',
    });
    await store.attach(b.$blob.uri, {
      executionId: 'r',
    });
    const states = Object.fromEntries(
      (await store.listRun('r')).map((r) => [
        r.uri,
        r.state,
      ]),
    );
    expect(states[pinned.$blob.uri]).toBe('stored');
    expect(states[a.$blob.uri]).toBe('dropped');
    expect(states[b.$blob.uri]).toBe('stored');
  });

  it('keeps a new blob and flags overCap when pinned blobs alone exceed a cap', async () => {
    const store = createFileArtifactStore({
      dir,
      retention: {
        maxCountPerRun: 1,
      },
    });
    const pinned = await store.put(bytesOf('evidence'), {
      mimeType: 'text/plain',
    });
    await store.attach(pinned.$blob.uri, {
      executionId: 'r',
      pinned: true,
    });
    const fresh = await store.put(bytesOf('new'), {
      mimeType: 'text/plain',
    });
    await store.attach(fresh.$blob.uri, {
      executionId: 'r',
    });
    const records = await store.listRun('r');
    expect(records.every((r) => r.state === 'stored')).toBe(true);
    expect(records.find((r) => r.uri === fresh.$blob.uri)?.overCap).toBe(true);
  });

  it('drops unpinned blobs past ttlMs on listRun, keeping pinned ones', async () => {
    const time = clock();
    const store = createFileArtifactStore({
      dir,
      now: time.now,
      retention: {
        ttlMs: 100,
      },
    });
    const old = await store.put(bytesOf('old'), {
      mimeType: 'text/plain',
    });
    const keep = await store.put(bytesOf('keep'), {
      mimeType: 'text/plain',
    });
    await store.attach(old.$blob.uri, {
      executionId: 'r',
    });
    await store.attach(keep.$blob.uri, {
      executionId: 'r',
      pinned: true,
    });
    time.advance(99);
    expect((await store.listRun('r')).every((r) => r.state === 'stored')).toBe(true);
    time.advance(1);
    const states = Object.fromEntries(
      (await store.listRun('r')).map((r) => [
        r.uri,
        r.state,
      ]),
    );
    expect(states[old.$blob.uri]).toBe('dropped');
    expect(states[keep.$blob.uri]).toBe('stored');
  });

  it('re-attaching a dropped blob that is stored again restores it', async () => {
    const time = clock();
    const store = createFileArtifactStore({
      dir,
      now: time.now,
      retention: {
        maxCountPerRun: 1,
      },
    });
    const a = await store.put(bytesOf('a'), {
      mimeType: 'text/plain',
    });
    await store.attach(a.$blob.uri, {
      executionId: 'r',
    });
    time.advance(1);
    const b = await store.put(bytesOf('b'), {
      mimeType: 'text/plain',
    });
    await store.attach(b.$blob.uri, {
      executionId: 'r',
    });
    time.advance(1);
    await store.put(bytesOf('a'), {
      mimeType: 'text/plain',
    });
    await store.attach(a.$blob.uri, {
      executionId: 'r',
    });
    const states = Object.fromEntries(
      (await store.listRun('r')).map((r) => [
        r.uri,
        r.state,
      ]),
    );
    expect(states[a.$blob.uri]).toBe('stored');
    expect(states[b.$blob.uri]).toBe('dropped');
  });
});

describe('createFileArtifactStore — shared content and clearRun', () => {
  it('content shared by two runs survives one run being cleared', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    const ref = await store.put(bytesOf('shared'), {
      mimeType: 'text/plain',
    });
    await store.attach(ref.$blob.uri, {
      executionId: 'r1',
    });
    await store.attach(ref.$blob.uri, {
      executionId: 'r2',
    });
    await store.clearRun('r1');
    expect(await store.listRun('r1')).toEqual([]);
    expect(await readAll(await store.get(ref.$blob.uri))).toBe('shared');
    await store.clearRun('r2');
    expect(await store.get(ref.$blob.uri)).toBeNull();
    expect(await store.head(ref.$blob.uri)).toBeNull();
  });

  it('a retention drop in one run keeps content another run still holds', async () => {
    const time = clock();
    const store = createFileArtifactStore({
      dir,
      now: time.now,
      retention: {
        maxCountPerRun: 1,
      },
    });
    const shared = await store.put(bytesOf('shared'), {
      mimeType: 'text/plain',
    });
    await store.attach(shared.$blob.uri, {
      executionId: 'r1',
    });
    await store.attach(shared.$blob.uri, {
      executionId: 'r2',
    });
    time.advance(1);
    const other = await store.put(bytesOf('other'), {
      mimeType: 'text/plain',
    });
    await store.attach(other.$blob.uri, {
      executionId: 'r1',
    });
    expect((await store.listRun('r1')).find((r) => r.uri === shared.$blob.uri)?.state).toBe(
      'dropped',
    );
    expect(await readAll(await store.get(shared.$blob.uri))).toBe('shared');
  });

  it('clearRun on an unknown run is a no-op', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    await store.clearRun('missing');
    expect(await store.listRun('missing')).toEqual([]);
  });

  it('serializes concurrent attaches to one run', async () => {
    const store = createFileArtifactStore({
      dir,
    });
    const refs = await Promise.all(
      Array.from(
        {
          length: 8,
        },
        (_, i) =>
          store.put(bytesOf(`c${i}`), {
            mimeType: 'text/plain',
          }),
      ),
    );
    await Promise.all(
      refs.map((ref) =>
        store.attach(ref.$blob.uri, {
          executionId: 'r',
        }),
      ),
    );
    expect(await store.listRun('r')).toHaveLength(8);
  });
});

describe('applyRetention', () => {
  const limits = {
    maxBytesPerRun: 100,
    maxCountPerRun: 2,
    ttlMs: undefined,
  };

  it('does nothing when the run fits (N-1 and N)', () => {
    const one = [
      record('u1', 1),
    ];
    const two = [
      record('u1', 1),
      record('u2', 2),
    ];
    expect(
      applyRetention({
        records: one,
        limits,
        now: 10,
      }),
    ).toEqual([]);
    expect(
      applyRetention({
        records: two,
        limits,
        now: 10,
      }),
    ).toEqual([]);
  });

  it('drops the oldest unpinned record at N+1, sparing the protected one', () => {
    const records = [
      record('u3', 3),
      record('u1', 1),
      record('u2', 2),
    ];
    expect(
      applyRetention({
        records,
        limits,
        now: 10,
        protect: 'u1',
      }),
    ).toEqual([
      'u2',
    ]);
  });

  it('flags the protected record overCap when nothing else can be evicted', () => {
    const records = [
      record('p1', 1, {
        pinned: true,
      }),
      record('p2', 2, {
        pinned: true,
      }),
      record('n', 3),
    ];
    expect(
      applyRetention({
        records,
        limits,
        now: 10,
        protect: 'n',
      }),
    ).toEqual([]);
    expect(records[2]?.overCap).toBe(true);
  });

  it('applies ttl at the boundary: kept at ttl-1, dropped at ttl', () => {
    const ttlLimits = {
      ...limits,
      maxCountPerRun: 10,
      ttlMs: 10,
    };
    expect(
      applyRetention({
        records: [
          record('u', 0),
        ],
        limits: ttlLimits,
        now: 9,
      }),
    ).toEqual([]);
    expect(
      applyRetention({
        records: [
          record('u', 0),
        ],
        limits: ttlLimits,
        now: 10,
      }),
    ).toEqual([
      'u',
    ]);
  });
});
