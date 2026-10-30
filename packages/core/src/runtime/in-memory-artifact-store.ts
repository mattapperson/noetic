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

/** The store's state, shared by its module-level handlers. */
interface StoreState {
  readonly retention: ArtifactRetention;
  readonly now: () => number;
  readonly contents: Map<string, StoredContent>;
  readonly runs: Map<string, MutableRecord[]>;
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

function markDropped(entry: MutableRecord): void {
  entry.record = {
    ...entry.record,
    state: 'dropped',
  };
}

function findStored(records: ReadonlyArray<MutableRecord>, uri: string): MutableRecord | undefined {
  return records.find((r) => r.record.uri === uri && r.record.state === 'stored');
}

function isLinked(state: StoreState, uri: string): boolean {
  for (const records of state.runs.values()) {
    if (findStored(records, uri)) {
      return true;
    }
  }
  return false;
}

function dropIfOrphaned(state: StoreState, uri: string): void {
  if (!isLinked(state, uri)) {
    state.contents.delete(uri);
  }
}

function expire(state: StoreState, records: MutableRecord[]): void {
  const ttl = state.retention.ttlMs;
  if (ttl === undefined) {
    return;
  }
  for (const entry of stored(records)) {
    if (!entry.record.pinned && state.now() - entry.record.attachedAt > ttl) {
      markDropped(entry);
    }
  }
}

/** Applies retention; returns whether pinned blobs alone keep the run over a cap. */
function enforce(state: StoreState, records: MutableRecord[]): boolean {
  expire(state, records);
  while (overLimits(records, state.retention)) {
    const oldest = stored(records).find((r) => !r.record.pinned);
    if (!oldest) {
      return true;
    }
    markDropped(oldest);
  }
  return false;
}

async function putContent(
  state: StoreState,
  content: Uint8Array | ReadableStream<Uint8Array>,
  meta: ArtifactMeta,
): Promise<BlobRef> {
  const bytes = await readAll(content);
  const sha256 = await sha256Hex(bytes);
  const uri = artifactUri(sha256);
  const existing = state.contents.get(uri);
  const body: BlobRefBody = existing?.body ?? {
    uri,
    mimeType: meta.mimeType,
    bytes: bytes.byteLength,
    sha256,
  };
  if (!existing) {
    state.contents.set(uri, {
      bytes,
      body,
      meta,
    });
  }
  return {
    $blob: body,
  };
}

function headContent(content: StoredContent | undefined):
  | (BlobRefBody & {
      readonly sensitive?: boolean;
    })
  | null {
  if (!content) {
    return null;
  }
  return content.meta.sensitive
    ? {
        ...content.body,
        sensitive: true,
      }
    : content.body;
}

function newRecord(state: StoreState, content: StoredContent, link: ArtifactLink): MutableRecord {
  return {
    record: {
      ...content.body,
      executionId: link.executionId,
      stepPath: link.stepPath,
      source: link.source,
      name: content.meta.name,
      sensitive: content.meta.sensitive,
      pinned: link.pinned ?? false,
      attachedAt: state.now(),
      state: 'stored',
    },
  };
}

function pinIfAsked(entry: MutableRecord, link: ArtifactLink): void {
  if (link.pinned && !entry.record.pinned) {
    entry.record = {
      ...entry.record,
      pinned: true,
    };
  }
}

function runRecords(state: StoreState, executionId: string): MutableRecord[] {
  const records = state.runs.get(executionId) ?? [];
  state.runs.set(executionId, records);
  return records;
}

function attachContent(state: StoreState, uri: string, link: ArtifactLink): void {
  const content = state.contents.get(uri);
  if (!content) {
    return;
  }
  const records = runRecords(state, link.executionId);
  const already = findStored(records, uri);
  if (already) {
    pinIfAsked(already, link);
    return;
  }
  const entry = newRecord(state, content, link);
  records.push(entry);
  const overCap = enforce(state, records);
  if (overCap && entry.record.state === 'stored') {
    entry.record = {
      ...entry.record,
      overCap: true,
    };
  }
  for (const record of records) {
    if (record.record.state === 'dropped') {
      dropIfOrphaned(state, record.record.uri);
    }
  }
}

function clearRunRecords(state: StoreState, executionId: string): void {
  const records = state.runs.get(executionId) ?? [];
  state.runs.delete(executionId);
  for (const entry of records) {
    dropIfOrphaned(state, entry.record.uri);
  }
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
  const state: StoreState = {
    retention: resolveRetention(options.retention),
    now: options.now ?? Date.now,
    contents: new Map(),
    runs: new Map(),
  };
  return {
    put: (content, meta) => putContent(state, content, meta),
    async get(uri): Promise<ReadableStream<Uint8Array> | null> {
      const content = state.contents.get(uri);
      return content ? streamOf(content.bytes) : null;
    },
    head: async (uri) => headContent(state.contents.get(uri)),
    attach: async (uri, link) => attachContent(state, uri, link),
    async listRun(executionId): Promise<ReadonlyArray<ArtifactRecord>> {
      const records = state.runs.get(executionId) ?? [];
      expire(state, records);
      return records.map((r) => r.record);
    },
    clearRun: async (executionId) => clearRunRecords(state, executionId),
  };
}

//#endregion
