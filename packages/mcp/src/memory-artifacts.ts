/**
 * A minimal in-memory `ArtifactStore`: content-addressed by SHA-256, with no
 * retention caps. For hosts without an artifact store of their own.
 */

import type {
  ArtifactLink,
  ArtifactMeta,
  ArtifactRecord,
  ArtifactStore,
  BlobRef,
  BlobRefBody,
} from '@noetic-tools/types';
import { artifactUri } from '@noetic-tools/types';

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
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

//#endregion

//#region Public API

/** @public An in-memory, content-addressed artifact store. */
export function createMemoryArtifactStore(): ArtifactStore {
  const blobs = new Map<
    string,
    {
      body: BlobRefBody;
      bytes: Uint8Array;
      meta: ArtifactMeta;
    }
  >();
  const links: ArtifactRecord[] = [];
  return {
    async put(
      content: Uint8Array | ReadableStream<Uint8Array>,
      meta: ArtifactMeta,
    ): Promise<BlobRef> {
      const bytes = await readAll(content);
      const sha256 = await sha256Hex(bytes);
      const body: BlobRefBody = {
        uri: artifactUri(sha256),
        mimeType: meta.mimeType,
        bytes: bytes.byteLength,
        sha256,
      };
      if (!blobs.has(body.uri)) {
        blobs.set(body.uri, {
          body,
          bytes,
          meta,
        });
      }
      return {
        $blob: body,
      };
    },
    async get(uri: string): Promise<ReadableStream<Uint8Array> | null> {
      const entry = blobs.get(uri);
      if (entry === undefined) {
        return null;
      }
      return new Blob([
        entry.bytes.slice(),
      ]).stream();
    },
    async head(uri: string): Promise<BlobRefBody | null> {
      return blobs.get(uri)?.body ?? null;
    },
    async attach(uri: string, link: ArtifactLink): Promise<void> {
      const entry = blobs.get(uri);
      if (entry === undefined) {
        return;
      }
      links.push({
        ...entry.body,
        executionId: link.executionId,
        ...(link.stepPath === undefined
          ? {}
          : {
              stepPath: link.stepPath,
            }),
        ...(link.source === undefined
          ? {}
          : {
              source: link.source,
            }),
        ...(entry.meta.name === undefined
          ? {}
          : {
              name: entry.meta.name,
            }),
        ...(entry.meta.sensitive === undefined
          ? {}
          : {
              sensitive: entry.meta.sensitive,
            }),
        pinned: link.pinned ?? false,
        attachedAt: Date.now(),
        state: 'stored',
      });
    },
    async listRun(executionId: string): Promise<ReadonlyArray<ArtifactRecord>> {
      return links.filter((record) => record.executionId === executionId);
    },
    async clearRun(executionId: string): Promise<void> {
      for (let i = links.length - 1; i >= 0; i--) {
        if (links[i]?.executionId === executionId) {
          links.splice(i, 1);
        }
      }
      const linked = new Set(links.map((record) => record.uri));
      for (const uri of blobs.keys()) {
        if (!linked.has(uri)) {
          blobs.delete(uri);
        }
      }
    },
  };
}

//#endregion
