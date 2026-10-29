/**
 * Turning MCP results into connection values. Every binary content block — an
 * image, audio, an embedded binary resource — is stored once in the artifact
 * store and stands as `{ $blob: { uri, mimeType, bytes, sha256 } }` in the
 * value (spec 35 § Refs and blobs). Structured content may carry binary
 * inline as `{ "$blob": { "data": <base64>, "mimeType": … } }`; it is stored
 * the same way.
 */

import type { ArtifactStore, BlobRef } from '@noetic-tools/types';
import type { z } from 'zod';
import type { ContentBlockSchema, ResourceContentSchema, ToolResult } from './wire';

//#region Types

type ContentBlock = z.infer<typeof ContentBlockSchema>;
type ResourceContent = z.infer<typeof ResourceContentSchema>;

//#endregion

//#region Helpers

/** @public Decodes base64 into bytes. */
export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function storeBase64(
  artifacts: ArtifactStore,
  data: string,
  mimeType: string,
): Promise<BlobRef> {
  return artifacts.put(decodeBase64(data), {
    mimeType,
  });
}

function inlineBlob(value: Record<string, unknown>):
  | {
      data: string;
      mimeType: string;
    }
  | undefined {
  const inner = value.$blob;
  if (Object.keys(value).length !== 1 || !isRecord(inner)) {
    return undefined;
  }
  if (typeof inner.data !== 'string' || typeof inner.mimeType !== 'string') {
    return undefined;
  }
  return {
    data: inner.data,
    mimeType: inner.mimeType,
  };
}

//#endregion

//#region Public API

/** @public Stores one content block's binary, if it has any, and returns the block to keep. */
export async function convertBlock(
  block: ContentBlock,
  artifacts: ArtifactStore,
): Promise<unknown> {
  if ((block.type === 'image' || block.type === 'audio') && typeof block.data === 'string') {
    const mimeType =
      typeof block.mimeType === 'string' ? block.mimeType : 'application/octet-stream';
    return storeBase64(artifacts, block.data, mimeType);
  }
  if (
    block.type === 'resource' &&
    isRecord(block.resource) &&
    typeof block.resource.blob === 'string'
  ) {
    const mimeType =
      typeof block.resource.mimeType === 'string'
        ? block.resource.mimeType
        : 'application/octet-stream';
    return storeBase64(artifacts, block.resource.blob, mimeType);
  }
  return block;
}

/** @public Replaces inline `{ $blob: { data, mimeType } }` values in structured content with stored blob refs. */
export async function storeInlineBlobs(value: unknown, artifacts: ArtifactStore): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => storeInlineBlobs(item, artifacts)));
  }
  if (!isRecord(value)) {
    return value;
  }
  const inline = inlineBlob(value);
  if (inline !== undefined) {
    return storeBase64(artifacts, inline.data, inline.mimeType);
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = await storeInlineBlobs(item, artifacts);
  }
  return out;
}

/**
 * @public
 * A successful tool result as an operation output: its structured content
 * when present, else `{ content }` with binary blocks stored as blobs.
 */
export async function toolResultOutput(
  result: ToolResult,
  artifacts: ArtifactStore,
): Promise<unknown> {
  if (result.structuredContent !== undefined) {
    return storeInlineBlobs(result.structuredContent, artifacts);
  }
  const content = await Promise.all(
    (result.content ?? []).map((block) => convertBlock(block, artifacts)),
  );
  return {
    content,
  };
}

/** @public The text of a tool result's text blocks, joined. */
export function toolResultText(result: ToolResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n');
}

function isJsonMime(mimeType: string | undefined): boolean {
  return mimeType === 'application/json' || (mimeType?.endsWith('+json') ?? false);
}

async function convertResourceContent(
  content: ResourceContent,
  artifacts: ArtifactStore,
): Promise<unknown> {
  if (content.blob !== undefined) {
    return storeBase64(artifacts, content.blob, content.mimeType ?? 'application/octet-stream');
  }
  const text = content.text ?? '';
  if (!isJsonMime(content.mimeType)) {
    return text;
  }
  return storeInlineBlobs(JSON.parse(text), artifacts);
}

/**
 * @public
 * A `resources/read` result as a read value: JSON content parsed, text as a
 * string, binary as a blob ref; several contents as an array.
 */
export async function resourceValue(
  contents: ReadonlyArray<ResourceContent>,
  artifacts: ArtifactStore,
): Promise<unknown> {
  const values = await Promise.all(
    contents.map((content) => convertResourceContent(content, artifacts)),
  );
  if (values.length === 1) {
    return values[0];
  }
  return values;
}

//#endregion
