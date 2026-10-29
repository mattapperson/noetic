/**
 * The default artifact store (spec 08 § Artifact Store): content-addressed
 * bytes in memory, linked to runs, with per-run retention. Used when
 * `environment.artifacts` is unset.
 *
 * - Identical content is stored once (`artifact://sha256/<hex>`).
 * - When a run exceeds a cap, its oldest unpinned blobs are dropped and the
 *   drop is recorded on the run's manifest (`state: 'dropped'`). When pinned
 *   blobs alone exceed a cap, new blobs are still stored and marked `overCap`.
 * - `clearRun` removes one run's links; content no run links to is removed.
 */

import type {
  ArtifactLink,
  ArtifactMeta,
  ArtifactRecord,
  ArtifactRetention,
  ArtifactStore,
  BlobRef,
  BlobRefBody,
} from '@noetic-tools/types';
import {
  artifactUri,
  DEFAULT_ARTIFACT_MAX_BYTES_PER_RUN,
  DEFAULT_ARTIFACT_MAX_COUNT_PER_RUN,
} from '@noetic-tools/types';

//#region Types

/** Options for `createInMemoryArtifactStore`. */
export interface InMemoryArtifactStoreOptions {
  readonly retention?: Partial<ArtifactRetention>;
  /** Clock for `attachedAt` and `ttlMs`; default `Date.now`. */
  readonly now?: () => number;
}

interface StoredContent {
  readonly bytes: Uint8Array;
  readonly body: BlobRefBody;
  readonly meta: ArtifactMeta;
}

interface MutableRecord {
  record: ArtifactRecord;
}

//#endregion

//#region Helpers

async function readAll(content: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (content instanceof Uint8Array) {
    return content;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = content.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copy));
  return [
    ...digest,
  ]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
}

function resolveRetention(retention: Partial<ArtifactRetention> | undefined): ArtifactRetention {
  return {
    maxBytesPerRun: retention?.maxBytesPerRun ?? DEFAULT_ARTIFACT_MAX_BYTES_PER_RUN,
    maxCountPerRun: retention?.maxCountPerRun ?? DEFAULT_ARTIFACT_MAX_COUNT_PER_RUN,
    ttlMs: retention?.ttlMs,
  };
}

function stored(records: ReadonlyArray<MutableRecord>): MutableRecord[] {
  return records.filter((r) => r.record.state === 'stored');
}

function overLimits(records: ReadonlyArray<MutableRecord>, retention: ArtifactRetention): boolean {
  const live = stored(records);
  const bytes = live.reduce((sum, r) => sum + r.record.bytes, 0);
  return live.length > retention.maxCountPerRun || bytes > retention.maxBytesPerRun;
}

//#endregion

//#region Public API

/**
 * @public
 * An `ArtifactStore` that keeps content in memory. The harness uses one when
 * `environment.artifacts` is unset.
 */
export function createInMemoryArtifactStore(
  options: InMemoryArtifactStoreOptions = {},
): ArtifactStore {
  const retention = resolveRetention(options.retention);
  const now = options.now ?? Date.now;
  const contents = new Map<string, StoredContent>();
  const runs = new Map<string, MutableRecord[]>();

  const isLinked = (uri: string): boolean => {
    for (const records of runs.values()) {
      if (records.some((r) => r.record.uri === uri && r.record.state === 'stored')) {
        return true;
      }
    }
    return false;
  };

  const dropIfOrphaned = (uri: string): void => {
    if (!isLinked(uri)) {
      contents.delete(uri);
    }
  };

  const expire = (records: MutableRecord[]): void => {
    const ttl = retention.ttlMs;
    if (ttl === undefined) {
      return;
    }
    for (const entry of stored(records)) {
      if (!entry.record.pinned && now() - entry.record.attachedAt > ttl) {
        entry.record = {
          ...entry.record,
          state: 'dropped',
        };
      }
    }
  };

  const enforce = (records: MutableRecord[]): boolean => {
    expire(records);
    while (overLimits(records, retention)) {
      const oldest = stored(records).find((r) => !r.record.pinned);
      if (!oldest) {
        return true;
      }
      oldest.record = {
        ...oldest.record,
        state: 'dropped',
      };
    }
    return false;
  };

  return {
    async put(content, meta): Promise<BlobRef> {
      const bytes = await readAll(content);
      const sha256 = await sha256Hex(bytes);
      const uri = artifactUri(sha256);
      const existing = contents.get(uri);
      const body: BlobRefBody = existing?.body ?? {
        uri,
        mimeType: meta.mimeType,
        bytes: bytes.byteLength,
        sha256,
      };
      if (!existing) {
        contents.set(uri, {
          bytes,
          body,
          meta,
        });
      }
      return {
        $blob: body,
      };
    },

    async get(uri): Promise<ReadableStream<Uint8Array> | null> {
      const content = contents.get(uri);
      return content ? streamOf(content.bytes) : null;
    },

    async head(uri): Promise<
      | (BlobRefBody & {
          readonly sensitive?: boolean;
        })
      | null
    > {
      const content = contents.get(uri);
      if (!content) {
        return null;
      }
      return content.meta.sensitive
        ? {
            ...content.body,
            sensitive: true,
          }
        : content.body;
    },

    async attach(uri, link: ArtifactLink): Promise<void> {
      const content = contents.get(uri);
      if (!content) {
        return;
      }
      const records = runs.get(link.executionId) ?? [];
      runs.set(link.executionId, records);
      const already = records.find((r) => r.record.uri === uri && r.record.state === 'stored');
      if (already) {
        if (link.pinned && !already.record.pinned) {
          already.record = {
            ...already.record,
            pinned: true,
          };
        }
        return;
      }
      const entry: MutableRecord = {
        record: {
          ...content.body,
          executionId: link.executionId,
          stepPath: link.stepPath,
          source: link.source,
          name: content.meta.name,
          sensitive: content.meta.sensitive,
          pinned: link.pinned ?? false,
          attachedAt: now(),
          state: 'stored',
        },
      };
      records.push(entry);
      const overCap = enforce(records);
      if (overCap && entry.record.state === 'stored') {
        entry.record = {
          ...entry.record,
          overCap: true,
        };
      }
      for (const record of records) {
        if (record.record.state === 'dropped') {
          dropIfOrphaned(record.record.uri);
        }
      }
    },

    async listRun(executionId): Promise<ReadonlyArray<ArtifactRecord>> {
      const records = runs.get(executionId) ?? [];
      expire(records);
      return records.map((r) => r.record);
    },

    async clearRun(executionId): Promise<void> {
      const records = runs.get(executionId) ?? [];
      runs.delete(executionId);
      for (const entry of records) {
        dropIfOrphaned(entry.record.uri);
      }
    },
  };
}

//#endregion
