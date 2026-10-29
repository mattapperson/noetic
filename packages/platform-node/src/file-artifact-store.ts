/**
 * File Artifact Store (spec 25 § File Artifact Store, spec 08 § Artifact
 * Store): the Node implementation of `environment.artifacts`.
 *
 * Layout under `dir`:
 * - `sha256/<aa>/<hex>`       — the content, written once
 * - `sha256/<aa>/<hex>.json`  — its sidecar metadata, including which runs hold a stored link
 * - `runs/<executionId>.json` — each run's artifact manifest
 * - `tmp/`                    — staging for in-flight `put`s
 *
 * All mutations go through one in-process lock. Two processes sharing a
 * `dir` are not coordinated; give each host its own directory.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ArtifactLink,
  ArtifactRecord,
  ArtifactRetention,
  ArtifactStore,
} from '@noetic-tools/core';
import {
  ARTIFACT_URI_PREFIX,
  artifactDigest,
  artifactUri,
  DEFAULT_ARTIFACT_MAX_BYTES_PER_RUN,
  DEFAULT_ARTIFACT_MAX_COUNT_PER_RUN,
} from '@noetic-tools/core';
import { z } from 'zod';

//#region Constants

const READ_CHUNK_BYTES = 64 * 1024;
const HEX_PATTERN = /^[0-9a-f]{64}$/;

//#endregion

//#region Types

type BlobBody = Awaited<ReturnType<ArtifactStore['head']>> & {};
type PutContent = Parameters<ArtifactStore['put']>[0];
type PutMeta = Parameters<ArtifactStore['put']>[1];

/** @public Options for `createFileArtifactStore`. */
export interface CreateFileArtifactStoreOptions {
  /** Root directory; created on first use. */
  readonly dir: string;
  /** Per-run caps; unset fields take the spec 08 defaults (512 MiB, 1e3 blobs, no TTL). */
  readonly retention?: Partial<ArtifactRetention>;
  /** Clock override for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

const SidecarSchema = z.object({
  uri: z.string(),
  mimeType: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(HEX_PATTERN),
  name: z.string().optional(),
  sensitive: z.boolean().optional(),
  createdAt: z.number(),
  runs: z.array(z.string()),
});

type Sidecar = z.infer<typeof SidecarSchema>;

const RecordSchema = z.object({
  uri: z.string(),
  mimeType: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(HEX_PATTERN),
  executionId: z.string(),
  stepPath: z.string().optional(),
  source: z.string().optional(),
  name: z.string().optional(),
  sensitive: z.boolean().optional(),
  pinned: z.boolean(),
  attachedAt: z.number(),
  state: z.enum([
    'stored',
    'dropped',
  ]),
  overCap: z.boolean().optional(),
});

const ManifestSchema = z.object({
  executionId: z.string(),
  records: z.array(RecordSchema),
});

type MutableRecord = z.infer<typeof RecordSchema>;
type Manifest = z.infer<typeof ManifestSchema>;

interface Paths {
  readonly dir: string;
  blob(hex: string): string;
  sidecar(hex: string): string;
  manifest(executionId: string): string;
  tmp(): string;
}

interface Limits {
  readonly maxBytesPerRun: number;
  readonly maxCountPerRun: number;
  readonly ttlMs: number | undefined;
}

interface RetentionInput {
  readonly records: MutableRecord[];
  readonly limits: Limits;
  readonly now: number;
  /** The uri just attached; never evicted to make room for itself. */
  readonly protect?: string;
}

//#endregion

//#region Helpers

function createPaths(dir: string): Paths {
  const shard = (hex: string): string => path.join(dir, 'sha256', hex.slice(0, 2));
  return {
    dir,
    blob: (hex) => path.join(shard(hex), hex),
    sidecar: (hex) => path.join(shard(hex), `${hex}.json`),
    // encodeURIComponent keeps `/` and `\` out of the file name.
    manifest: (executionId) => path.join(dir, 'runs', `${encodeURIComponent(executionId)}.json`),
    tmp: () => path.join(dir, 'tmp', randomUUID()),
  };
}

function isMissing(err: Error): boolean {
  return 'code' in err && err.code === 'ENOENT';
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err instanceof Error && isMissing(err)) {
      return null;
    }
    throw err;
  }
  const parsed = schema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `createFileArtifactStore: corrupt metadata file ${file}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

async function writeJson(file: string, value: object): Promise<void> {
  await mkdir(path.dirname(file), {
    recursive: true,
  });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

/** Writes `content` to `file` while hashing it. */
async function stageContent(
  content: PutContent,
  file: string,
): Promise<{
  hex: string;
  bytes: number;
}> {
  await mkdir(path.dirname(file), {
    recursive: true,
  });
  const hash = createHash('sha256');
  const handle = await open(file, 'w');
  let bytes = 0;
  try {
    if (content instanceof Uint8Array) {
      hash.update(content);
      await handle.write(content);
      bytes = content.byteLength;
    } else {
      for await (const chunk of content) {
        hash.update(chunk);
        await handle.write(chunk);
        bytes += chunk.byteLength;
      }
    }
  } finally {
    await handle.close();
  }
  return {
    hex: hash.digest('hex'),
    bytes,
  };
}

/** A pull-based stream over a file, so large recordings are never read whole. */
async function fileStream(file: string): Promise<ReadableStream<Uint8Array> | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, 'r');
  } catch (err) {
    if (err instanceof Error && isMissing(err)) {
      return null;
    }
    throw err;
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const buffer = new Uint8Array(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, null);
      if (bytesRead === 0) {
        await handle.close();
        controller.close();
        return;
      }
      controller.enqueue(buffer.subarray(0, bytesRead));
    },
    async cancel(): Promise<void> {
      await handle.close();
    },
  });
}

function bodyOf(sidecar: Sidecar): BlobBody {
  return {
    uri: sidecar.uri,
    mimeType: sidecar.mimeType,
    bytes: sidecar.bytes,
    sha256: sidecar.sha256,
  };
}

function resolveLimits(retention: Partial<ArtifactRetention> | undefined): Limits {
  return {
    maxBytesPerRun: retention?.maxBytesPerRun ?? DEFAULT_ARTIFACT_MAX_BYTES_PER_RUN,
    maxCountPerRun: retention?.maxCountPerRun ?? DEFAULT_ARTIFACT_MAX_COUNT_PER_RUN,
    ttlMs: retention?.ttlMs,
  };
}

function storedTotals(records: ReadonlyArray<MutableRecord>): {
  count: number;
  bytes: number;
} {
  let count = 0;
  let bytes = 0;
  for (const record of records) {
    if (record.state !== 'stored') {
      continue;
    }
    count += 1;
    bytes += record.bytes;
  }
  return {
    count,
    bytes,
  };
}

function overLimits(records: ReadonlyArray<MutableRecord>, limits: Limits): boolean {
  const totals = storedTotals(records);
  return totals.count > limits.maxCountPerRun || totals.bytes > limits.maxBytesPerRun;
}

function oldestEvictable(
  records: ReadonlyArray<MutableRecord>,
  protect: string | undefined,
): MutableRecord | undefined {
  let oldest: MutableRecord | undefined;
  for (const record of records) {
    if (record.state !== 'stored' || record.pinned || record.uri === protect) {
      continue;
    }
    if (!oldest || record.attachedAt < oldest.attachedAt) {
      oldest = record;
    }
  }
  return oldest;
}

/**
 * Applies TTL and the per-run caps to a manifest in place: drops expired
 * unpinned blobs, then the oldest unpinned blobs until the run fits. When
 * pinned blobs keep it over a cap, the protected (new) blob stays stored and
 * is flagged `overCap`.
 * @returns The uris whose record this call dropped.
 * @internal Exported for tests; not part of the package entry.
 */
export function applyRetention(input: RetentionInput): string[] {
  const { records, limits, now, protect } = input;
  const dropped: string[] = [];
  const drop = (record: MutableRecord): void => {
    record.state = 'dropped';
    dropped.push(record.uri);
  };
  const ttl = limits.ttlMs;
  if (ttl !== undefined) {
    for (const record of records) {
      if (record.state === 'stored' && !record.pinned && record.attachedAt + ttl <= now) {
        drop(record);
      }
    }
  }
  while (overLimits(records, limits)) {
    const victim = oldestEvictable(records, protect);
    if (!victim) {
      break;
    }
    drop(victim);
  }
  const fresh = records.find((r) => r.uri === protect && r.state === 'stored');
  if (fresh && overLimits(records, limits)) {
    fresh.overCap = true;
  }
  return dropped;
}

function newRecord(sidecar: Sidecar, link: ArtifactLink, now: number): MutableRecord {
  return {
    ...bodyOf(sidecar),
    executionId: link.executionId,
    ...(link.stepPath !== undefined && {
      stepPath: link.stepPath,
    }),
    ...(link.source !== undefined && {
      source: link.source,
    }),
    ...(sidecar.name !== undefined && {
      name: sidecar.name,
    }),
    ...(sidecar.sensitive !== undefined && {
      sensitive: sidecar.sensitive,
    }),
    pinned: link.pinned ?? false,
    attachedAt: now,
    state: 'stored',
  };
}

/** Re-links an existing record: a pin is sticky, a dropped blob that is back on disk is stored again. */
function relink(record: MutableRecord, link: ArtifactLink, now: number): void {
  if (link.pinned) {
    record.pinned = true;
  }
  if (record.state === 'dropped') {
    record.state = 'stored';
    record.attachedAt = now;
    record.overCap = undefined;
  }
}

//#endregion

//#region Store internals

interface StoreState {
  readonly paths: Paths;
  readonly limits: Limits;
  readonly now: () => number;
}

async function loadManifest(state: StoreState, executionId: string): Promise<Manifest> {
  const manifest = await readJson(state.paths.manifest(executionId), ManifestSchema);
  return (
    manifest ?? {
      executionId,
      records: [],
    }
  );
}

async function loadSidecar(state: StoreState, hex: string): Promise<Sidecar | null> {
  return readJson(state.paths.sidecar(hex), SidecarSchema);
}

/** Removes `executionId` from a blob's holders; deletes the content when no run holds it. */
async function releaseLink(state: StoreState, uri: string, executionId: string): Promise<void> {
  const hex = artifactDigest(uri);
  if (!hex) {
    return;
  }
  const sidecar = await loadSidecar(state, hex);
  if (!sidecar) {
    return;
  }
  const runs = sidecar.runs.filter((run) => run !== executionId);
  if (runs.length > 0) {
    await writeJson(state.paths.sidecar(hex), {
      ...sidecar,
      runs,
    });
    return;
  }
  await rm(state.paths.blob(hex), {
    force: true,
  });
  await rm(state.paths.sidecar(hex), {
    force: true,
  });
}

async function holdLink(state: StoreState, hex: string, executionId: string): Promise<Sidecar> {
  const sidecar = await loadSidecar(state, hex);
  if (!sidecar || !(await exists(state.paths.blob(hex)))) {
    throw new Error(`createFileArtifactStore: no stored artifact ${ARTIFACT_URI_PREFIX}${hex}`);
  }
  if (sidecar.runs.includes(executionId)) {
    return sidecar;
  }
  const updated = {
    ...sidecar,
    runs: [
      ...sidecar.runs,
      executionId,
    ],
  };
  await writeJson(state.paths.sidecar(hex), updated);
  return updated;
}

/**
 * Applies retention and persists the manifest. Caps are enforced only when a
 * blob is attached (`protect` set); a plain read applies TTL alone, so a blob
 * kept `overCap` is not evicted after the fact.
 */
async function saveWithRetention(
  state: StoreState,
  manifest: Manifest,
  protect: string | undefined,
): Promise<void> {
  const limits =
    protect === undefined
      ? {
          ...state.limits,
          maxBytesPerRun: Number.POSITIVE_INFINITY,
          maxCountPerRun: Number.POSITIVE_INFINITY,
        }
      : state.limits;
  const dropped = applyRetention({
    records: manifest.records,
    limits,
    now: state.now(),
    protect,
  });
  if (protect === undefined && dropped.length === 0) {
    return;
  }
  await writeJson(state.paths.manifest(manifest.executionId), manifest);
  for (const uri of dropped) {
    await releaseLink(state, uri, manifest.executionId);
  }
}

async function putContent(state: StoreState, content: PutContent, meta: PutMeta): Promise<Sidecar> {
  const staged = state.paths.tmp();
  const { hex, bytes } = await stageContent(content, staged);
  const existing = await loadSidecar(state, hex);
  const blobFile = state.paths.blob(hex);
  if (await exists(blobFile)) {
    await rm(staged, {
      force: true,
    });
  } else {
    await mkdir(path.dirname(blobFile), {
      recursive: true,
    });
    await rename(staged, blobFile);
  }
  const sidecar: Sidecar = {
    uri: artifactUri(hex),
    mimeType: existing?.mimeType ?? meta.mimeType,
    bytes,
    sha256: hex,
    name: existing?.name ?? meta.name,
    // Sensitivity is sticky: once any writer marks content sensitive it stays so.
    sensitive: existing?.sensitive || meta.sensitive || undefined,
    createdAt: existing?.createdAt ?? state.now(),
    runs: existing?.runs ?? [],
  };
  await writeJson(state.paths.sidecar(hex), sidecar);
  return sidecar;
}

async function attachLink(state: StoreState, uri: string, link: ArtifactLink): Promise<void> {
  const hex = artifactDigest(uri);
  if (!hex) {
    throw new Error(`createFileArtifactStore: not an artifact uri: ${uri}`);
  }
  const sidecar = await holdLink(state, hex, link.executionId);
  const manifest = await loadManifest(state, link.executionId);
  const now = state.now();
  const record = manifest.records.find((r) => r.uri === uri);
  if (record) {
    relink(record, link, now);
  } else {
    manifest.records.push(newRecord(sidecar, link, now));
  }
  await saveWithRetention(state, manifest, uri);
}

async function listRunRecords(state: StoreState, executionId: string): Promise<ArtifactRecord[]> {
  if (!(await exists(state.paths.manifest(executionId)))) {
    return [];
  }
  const manifest = await loadManifest(state, executionId);
  await saveWithRetention(state, manifest, undefined);
  return manifest.records.map((record) => ({
    ...record,
  }));
}

async function clearRunLinks(state: StoreState, executionId: string): Promise<void> {
  const manifest = await loadManifest(state, executionId);
  for (const record of manifest.records) {
    if (record.state === 'stored') {
      await releaseLink(state, record.uri, executionId);
    }
  }
  await rm(state.paths.manifest(executionId), {
    force: true,
  });
}

async function headBlob(
  state: StoreState,
  uri: string,
): Promise<
  | (BlobBody & {
      readonly sensitive?: boolean;
    })
  | null
> {
  const hex = artifactDigest(uri);
  if (!hex) {
    return null;
  }
  const sidecar = await loadSidecar(state, hex);
  if (!sidecar || !(await exists(state.paths.blob(hex)))) {
    return null;
  }
  // Sensitive content is never rendered to the model (spec 35 § Refs and blobs).
  return sidecar.sensitive
    ? {
        ...bodyOf(sidecar),
        sensitive: true,
      }
    : bodyOf(sidecar);
}

//#endregion

//#region Public API

/**
 * @public
 * Create a file-backed `ArtifactStore` (spec 25 § File Artifact Store).
 * Content is addressed by its SHA-256 and written once; retention is enforced
 * per run on every `attach` and `listRun`; `clearRun` removes one run's links
 * and deletes content that no other run holds.
 */
export function createFileArtifactStore(options: CreateFileArtifactStoreOptions): ArtifactStore {
  const state: StoreState = {
    paths: createPaths(path.resolve(options.dir)),
    limits: resolveLimits(options.retention),
    now: options.now ?? Date.now,
  };
  let lock: Promise<void> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = lock.then(fn);
    lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    async put(content, meta) {
      const sidecar = await exclusive(() => putContent(state, content, meta));
      return {
        $blob: bodyOf(sidecar),
      };
    },
    async get(uri) {
      const hex = artifactDigest(uri);
      return hex ? fileStream(state.paths.blob(hex)) : null;
    },
    head(uri) {
      return headBlob(state, uri);
    },
    attach(uri, link) {
      return exclusive(() => attachLink(state, uri, link));
    },
    listRun(executionId) {
      return exclusive(() => listRunRecords(state, executionId));
    },
    clearRun(executionId) {
      return exclusive(() => clearRunLinks(state, executionId));
    },
  };
}

//#endregion
