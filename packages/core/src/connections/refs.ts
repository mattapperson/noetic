/**
 * Refs (spec 35 § Refs and blobs). A ref is
 * `{ $ref: { connection, kind, id, seal } }`. `seal` is an HMAC over the rest
 * and the issuing thread and, for refs a profile marks volatile, over the
 * connection's identity instance too. The harness seals refs on the way in
 * (outputs, reads, event payloads) and checks them on the way out, so a ref
 * cannot be forged, used from another thread, or reused after the thing it
 * pointed into was replaced. Refs a profile marks `public` skip the thread
 * check.
 *
 * Seal format: `<keyId>.<mac>` for a stable ref, `<keyId>.<mac>.<instanceMac>`
 * for a volatile one, where `mac` covers connection, kind, id and thread and
 * `instanceMac` covers `mac` and the instance. A volatile ref whose `mac`
 * verifies but whose `instanceMac` does not is stale rather than forged.
 *
 * Signing keys live in the harness `StorageAdapter` and rotate with an
 * overlap, so refs survive a restart.
 */

import type { AnyProfile, Ref, RefBody, StorageAdapter } from '@noetic-tools/types';
import { isRef, profileFieldOf } from '@noetic-tools/types';
import { z } from 'zod';
import { refInvalidError } from './errors';
import { findDeep, isPlainRecord, mapDeep } from './values';

//#region Types

/** What a profile says about refs of one kind. */
export interface RefKindInfo {
  readonly volatile: boolean;
  readonly public: boolean;
}

/** Where a ref is sealed or checked. */
export interface RefScope {
  /** The harness connection name. */
  readonly connection: string;
  readonly threadId: string;
  /** The connection's current identity instance. */
  readonly instance: string;
  /**
   * The pool lease the connection is held under. A leased connection is never
   * shared with another holder, so its refs — of every kind — are bound to the
   * lease: a ref from one path's browser is refused by another path's.
   */
  readonly lease?: string;
  readonly kindInfo: (kind: string) => RefKindInfo;
}

interface StoredKey {
  readonly id: string;
  /** Base64 of the raw key bytes. */
  readonly secret: string;
  readonly createdAt: number;
}

interface StoredKeys {
  readonly keys: ReadonlyArray<StoredKey>;
}

//#endregion

//#region Constants

const KEYS_STORAGE_KEY = 'noetic/connections/ref-keys';
/** A new signing key is made after this long. */
const ROTATE_MS = 7 * 24 * 3600e3;
/** Old keys still verify for this long after they stop signing. */
const OVERLAP_MS = 7 * 24 * 3600e3;
const STABLE: RefKindInfo = {
  volatile: false,
  public: false,
};

const StoredKeysSchema = z.object({
  keys: z.array(
    z.object({
      id: z.string(),
      secret: z.string(),
      createdAt: z.number(),
    }),
  ),
});

//#endregion

//#region Helpers

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function newStoredKey(now: number): StoredKey {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of raw) {
    binary += String.fromCharCode(byte);
  }
  return {
    id: crypto.randomUUID().slice(0, 8),
    secret: btoa(binary),
    createdAt: now,
  };
}

/** A ref body a provider handed out, not yet sealed: `kind` and `id`, no `seal`. */
function isIssuedRef(value: unknown): value is {
  $ref: {
    kind: string;
    id: string;
  };
} {
  if (!isPlainRecord(value) || !isPlainRecord(value.$ref)) {
    return false;
  }
  const body = value.$ref;
  return (
    Object.keys(value).length === 1 &&
    typeof body.kind === 'string' &&
    typeof body.id === 'string' &&
    body.seal === undefined
  );
}

//#endregion

//#region RefSealer

/** Seals and checks refs with keys kept in storage. */
export class RefSealer {
  private keysPromise: Promise<ReadonlyArray<StoredKey>> | undefined;
  private readonly cryptoKeys = new Map<string, Promise<CryptoKey>>();

  constructor(
    private readonly storage: StorageAdapter,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seals a provider-issued ref for `scope`. */
  async seal(
    body: {
      readonly kind: string;
      readonly id: string;
    },
    scope: RefScope,
  ): Promise<Ref> {
    const keys = await this.keys();
    const key = keys[keys.length - 1];
    if (!key) {
      throw new Error('ref signing key missing');
    }
    const info = scope.kindInfo(body.kind);
    const mac = await this.mac(key, [
      scope.connection,
      body.kind,
      body.id,
      info.public ? '' : scope.threadId,
      ...leasePart(scope),
    ]);
    const parts = [
      key.id,
      mac,
    ];
    if (info.volatile) {
      parts.push(
        await this.mac(key, [
          mac,
          scope.instance,
        ]),
      );
    }
    return {
      $ref: {
        connection: scope.connection,
        kind: body.kind,
        id: body.id,
        seal: parts.join('.'),
      },
    };
  }

  /**
   * Checks a ref going out to `scope.connection`.
   *
   * @throws NoeticErrorImpl `connection_ref_invalid` when the ref belongs to another
   * connection, was not issued here (or to this thread), or is stale.
   */
  async check(ref: RefBody, scope: RefScope): Promise<void> {
    if (ref.connection !== scope.connection) {
      throw refInvalidError(
        scope.connection,
        `ref ${ref.kind} '${ref.id}' belongs to connection '${ref.connection}'`,
      );
    }
    const [keyId, mac, instanceMac] = ref.seal.split('.');
    const keys = await this.keys();
    const key = keys.find((k) => k.id === keyId);
    const info = scope.kindInfo(ref.kind);
    const expected = key
      ? await this.mac(key, [
          ref.connection,
          ref.kind,
          ref.id,
          info.public ? '' : scope.threadId,
          ...leasePart(scope),
        ])
      : undefined;
    if (!key || expected !== mac) {
      throw refInvalidError(
        scope.connection,
        `ref ${ref.kind} '${ref.id}' was not issued by this harness to this thread${scope.lease ? ' on this lease' : ''}`,
      );
    }
    if (!info.volatile) {
      return;
    }
    const expectedInstance = await this.mac(key, [
      mac,
      scope.instance,
    ]);
    if (expectedInstance !== instanceMac) {
      throw refInvalidError(
        scope.connection,
        `ref ${ref.kind} '${ref.id}' is stale: the connection was replaced`,
      );
    }
  }

  /** A copy of `value` with every provider-issued ref sealed for `scope`. */
  async sealAll(value: unknown, scope: RefScope): Promise<unknown> {
    const issued = findDeep(value, isIssuedRef);
    if (issued.length === 0) {
      return value;
    }
    const sealed = new Map<string, Ref>();
    for (const found of issued) {
      const body = found.value.$ref;
      const cacheKey = `${body.kind}\u0000${body.id}`;
      if (!sealed.has(cacheKey)) {
        sealed.set(cacheKey, await this.seal(body, scope));
      }
    }
    return mapDeep(value, (node) =>
      isIssuedRef(node.value)
        ? {
            replace: sealed.get(`${node.value.$ref.kind}\u0000${node.value.$ref.id}`),
          }
        : undefined,
    );
  }

  /** Checks every ref in `value` (see `check`). */
  async checkAll(value: unknown, scope: RefScope): Promise<void> {
    for (const found of findDeep(value, isRef)) {
      await this.check(found.value.$ref, scope);
    }
  }

  private async keys(): Promise<ReadonlyArray<StoredKey>> {
    if (!this.keysPromise) {
      this.keysPromise = this.loadKeys().catch((e: unknown) => {
        this.keysPromise = undefined;
        throw e;
      });
    }
    const keys = await this.keysPromise;
    const newest = keys[keys.length - 1];
    if (newest && this.now() - newest.createdAt < ROTATE_MS) {
      return keys;
    }
    this.keysPromise = this.rotate(keys);
    return this.keysPromise;
  }

  private async loadKeys(): Promise<ReadonlyArray<StoredKey>> {
    const parsed = StoredKeysSchema.safeParse(await this.storage.get<StoredKeys>(KEYS_STORAGE_KEY));
    if (parsed.success && parsed.data.keys.length > 0) {
      return parsed.data.keys;
    }
    return this.rotate([]);
  }

  private async rotate(keys: ReadonlyArray<StoredKey>): Promise<ReadonlyArray<StoredKey>> {
    const now = this.now();
    const kept = keys.filter((k) => now - k.createdAt < ROTATE_MS + OVERLAP_MS);
    const next = [
      ...kept,
      newStoredKey(now),
    ];
    await this.storage.set<StoredKeys>(KEYS_STORAGE_KEY, {
      keys: next,
    });
    return next;
  }

  private cryptoKey(key: StoredKey): Promise<CryptoKey> {
    const cached = this.cryptoKeys.get(key.id);
    if (cached) {
      return cached;
    }
    const imported = crypto.subtle.importKey(
      'raw',
      base64ToBytes(key.secret),
      {
        name: 'HMAC',
        hash: 'SHA-256',
      },
      false,
      [
        'sign',
      ],
    );
    this.cryptoKeys.set(key.id, imported);
    return imported;
  }

  private async mac(key: StoredKey, parts: ReadonlyArray<string>): Promise<string> {
    const data = new TextEncoder().encode(JSON.stringify(parts));
    const signature = await crypto.subtle.sign('HMAC', await this.cryptoKey(key), data);
    return bytesToBase64Url(new Uint8Array(signature)).slice(0, 32);
  }
}

//#endregion

//#region Ref kinds from profiles

function collectFromSchema(
  schema: z.core.$ZodType,
  into: Map<string, RefKindInfo>,
  depth: number,
): void {
  if (depth > 32) {
    return;
  }
  const meta = profileFieldOf(schema);
  if (meta?.kind === 'ref') {
    into.set(meta.refKind, {
      volatile: meta.volatile,
      public: meta.public,
    });
    return;
  }
  const next = depth + 1;
  if (schema instanceof z.ZodObject) {
    for (const child of Object.values(schema.shape)) {
      collectFromSchema(child, into, next);
    }
    return;
  }
  if (schema instanceof z.ZodArray) {
    collectFromSchema(schema.element, into, next);
    return;
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    collectFromSchema(schema.unwrap(), into, next);
    return;
  }
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) {
      collectFromSchema(option, into, next);
    }
    return;
  }
  if (schema instanceof z.ZodRecord) {
    collectFromSchema(schema.valueType, into, next);
  }
}

/** Every ref kind a profile's operations, reads and events hand out, with its flags. */
export function refKindsOf(profile: AnyProfile): Map<string, RefKindInfo> {
  const kinds = new Map<string, RefKindInfo>();
  for (const op of Object.values(profile.operations)) {
    collectFromSchema(op.input, kinds, 0);
    collectFromSchema(op.output, kinds, 0);
  }
  for (const read of Object.values(profile.reads)) {
    collectFromSchema(read.schema, kinds, 0);
  }
  for (const event of Object.values(profile.events)) {
    collectFromSchema(event.payload, kinds, 0);
  }
  return kinds;
}

/** The MAC part binding a ref to its lease; empty for a connection held without one. */
function leasePart(scope: RefScope): string[] {
  return scope.lease
    ? [
        `lease:${scope.lease}`,
      ]
    : [];
}

/** Looks a ref kind up in `kinds`; unknown kinds are stable and private. */
export function kindInfoFrom(
  kinds: ReadonlyMap<string, RefKindInfo>,
): (kind: string) => RefKindInfo {
  return (kind) => kinds.get(kind) ?? STABLE;
}

/** The connections the refs in `value` were issued by. */
export function refConnections(value: unknown): ReadonlySet<string> {
  return new Set(findDeep(value, isRef).map((found) => found.value.$ref.connection));
}

//#endregion
