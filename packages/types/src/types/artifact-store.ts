/**
 * The artifact store (spec 08 § Artifact Store): the fifth platform adapter,
 * `environment.artifacts`. Binary content the runtime must keep — screenshots,
 * recordings, downloads, verification runs — is stored here, content-addressed,
 * and referenced everywhere else by a `BlobRef`.
 */

import type { BlobRef, BlobRefBody } from './connection';

//#region Constants

/** @public The URI prefix of a stored artifact: `artifact://sha256/<hex>`. */
export const ARTIFACT_URI_PREFIX = 'artifact://sha256/';

/** @public Default per-run byte cap (512 MiB). */
export const DEFAULT_ARTIFACT_MAX_BYTES_PER_RUN = 512 * 1024 * 1024;

/** @public Default per-run artifact count cap. */
export const DEFAULT_ARTIFACT_MAX_COUNT_PER_RUN = 1e3;

//#endregion

//#region Types

/** @public What `put` records alongside the bytes. */
export interface ArtifactMeta {
  readonly mimeType: string;
  /** A hint for retention and display; never part of the content address. */
  readonly name?: string;
  /** Never rendered to the model and never attached to traces. */
  readonly sensitive?: boolean;
}

/** @public Per-run retention caps a store enforces. */
export interface ArtifactRetention {
  /** Default 512 MiB. */
  readonly maxBytesPerRun: number;
  /** Default 1e3. */
  readonly maxCountPerRun: number;
  /** Unset: kept until deleted. */
  readonly ttlMs?: number;
}

/** @public How a stored blob is linked to a run. */
export interface ArtifactLink {
  readonly executionId: string;
  readonly stepPath?: string;
  /** What produced it: a connection name, `'verify'`, `'trace'`. */
  readonly source?: string;
  /** Exempt from retention until its run is cleared (a ledger completion or verification run references it). */
  readonly pinned?: boolean;
}

/** @public One entry of a run's artifact manifest. */
export interface ArtifactRecord extends BlobRefBody {
  readonly executionId: string;
  readonly stepPath?: string;
  readonly source?: string;
  readonly name?: string;
  readonly sensitive?: boolean;
  readonly pinned: boolean;
  /** Epoch ms the link was made. */
  readonly attachedAt: number;
  /** `'dropped'` when retention evicted the content. */
  readonly state: 'stored' | 'dropped';
  /** `true` when this blob was stored although pinned blobs alone exceed a cap. */
  readonly overCap?: boolean;
}

/** @public The artifact store contract (`environment.artifacts`). */
export interface ArtifactStore {
  /** Stores bytes; content-addressed, so identical content is stored once. */
  put(content: Uint8Array | ReadableStream<Uint8Array>, meta: ArtifactMeta): Promise<BlobRef>;
  get(uri: string): Promise<ReadableStream<Uint8Array> | null>;
  /** What the store holds for `uri`; `sensitive` when any writer marked the content sensitive. */
  head(uri: string): Promise<
    | (BlobRef['$blob'] & {
        readonly sensitive?: boolean;
      })
    | null
  >;
  /** Associates a stored blob with a run; retention counts per run. */
  attach(uri: string, link: ArtifactLink): Promise<void>;
  listRun(executionId: string): Promise<ReadonlyArray<ArtifactRecord>>;
  /** Drops a run's links; content no run links to is removed. */
  clearRun(executionId: string): Promise<void>;
}

//#endregion

//#region Helpers

/** @public The content address of a SHA-256 hex digest. */
export function artifactUri(sha256Hex: string): string {
  return `${ARTIFACT_URI_PREFIX}${sha256Hex}`;
}

/**
 * @public
 * The SHA-256 hex digest inside an artifact URI.
 * @returns The digest, or `undefined` when `uri` is not an artifact URI.
 */
export function artifactDigest(uri: string): string | undefined {
  if (!uri.startsWith(ARTIFACT_URI_PREFIX)) {
    return undefined;
  }
  const hex = uri.slice(ARTIFACT_URI_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

//#endregion
