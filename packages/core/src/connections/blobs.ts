/**
 * Blobs (spec 35 § Refs and blobs). A provider stores binary content in the
 * artifact store and hands back `{ $blob: { uri, mimeType, bytes, sha256 } }`.
 * The harness links every blob it sees in an output, read or event to the run
 * that received it (retention counts per run), and checks that a blob going
 * out to a connection is one the store holds.
 */

import type { ArtifactStore, BlobRef } from '@noetic-tools/types';
import { isBlobRef } from '@noetic-tools/types';
import { refInvalidError } from './errors';
import { findDeep, mapDeep } from './values';

//#region Types

/** Where blobs are being linked. */
export interface BlobLink {
  readonly executionId: string;
  /** The connection that produced them. */
  readonly source: string;
  readonly stepPath?: string;
}

/** What a sensitive blob shows as wherever the model would see it. */
export const WITHHELD_BLOB_TEXT = '[sensitive blob withheld]';
//#endregion

//#region Public API

/** The blobs anywhere in `value`. */
export function findBlobs(value: unknown): ReadonlyArray<BlobRef> {
  return findDeep(value, isBlobRef).map((found) => found.value);
}

/** Links every blob in `value` to the run in `link`. */
export async function attachBlobs(
  value: unknown,
  artifacts: ArtifactStore,
  link: BlobLink,
): Promise<void> {
  const seen = new Set<string>();
  for (const blob of findBlobs(value)) {
    const uri = blob.$blob.uri;
    if (seen.has(uri)) {
      continue;
    }
    seen.add(uri);
    await artifacts.attach(uri, {
      executionId: link.executionId,
      source: link.source,
      stepPath: link.stepPath,
    });
  }
}

/**
 * Checks every blob in `args` is held by the artifact store and matches what it holds.
 *
 * @throws NoeticErrorImpl `connection_ref_invalid` for an unknown or altered blob.
 */
export async function checkBlobs(
  args: unknown,
  artifacts: ArtifactStore,
  connection: string,
): Promise<void> {
  for (const blob of findBlobs(args)) {
    const held = await artifacts.head(blob.$blob.uri);
    if (!held) {
      throw refInvalidError(connection, `blob '${blob.$blob.uri}' is not in the artifact store`);
    }
    if (held.sha256 !== blob.$blob.sha256 || held.bytes !== blob.$blob.bytes) {
      throw refInvalidError(
        connection,
        `blob '${blob.$blob.uri}' does not match the stored content`,
      );
    }
  }
}

/**
 * A copy of `value` with every blob the store marks sensitive (a stored session)
 * replaced by `WITHHELD_BLOB_TEXT`: such blobs are never rendered to the model
 * (spec 35 § Refs and blobs).
 */
export async function withholdSensitiveBlobs(
  value: unknown,
  artifacts: ArtifactStore,
): Promise<unknown> {
  const sensitive = new Set<string>();
  for (const blob of findBlobs(value)) {
    const uri = blob.$blob.uri;
    if (sensitive.has(uri)) {
      continue;
    }
    const held = await artifacts.head(uri);
    if (held?.sensitive) {
      sensitive.add(uri);
    }
  }
  if (sensitive.size === 0) {
    return value;
  }
  return mapDeep(value, (node) =>
    isBlobRef(node.value) && sensitive.has(node.value.$blob.uri)
      ? {
          replace: WITHHELD_BLOB_TEXT,
        }
      : undefined,
  );
}

//#endregion
