/**
 * The plain values connections pass around: refs, blob refs, secrets and
 * receipts (spec 35 § Values). Kept apart from the provider contract so
 * profiles and the artifact store can use them without importing it.
 */

import { z } from 'zod';
import { NoeticConfigError } from '../errors/noetic-config-error';

//#region Values: refs, blobs, secrets, receipts

/** @public The body of a ref: who issued it, what kind of thing it names, its id, and the harness seal. */
export interface RefBody<K extends string = string> {
  readonly connection: string;
  readonly kind: K;
  readonly id: string;
  /** HMAC over the rest, the issuing thread and, for volatile refs, the connection's identity instance. */
  readonly seal: string;
}

/**
 * @public
 * An id a connection handed out — a thread, a message, an installed app. Pass it
 * back as you got it; the harness routes the call to the connection that issued
 * it. The same shape in TypeScript and JSON: `{ "$ref": { connection, kind, id, seal } }`.
 * Read its id with `refId(ref)` (in an expression, `$refId(x)`).
 */
export interface Ref<K extends string = string> {
  readonly $ref: RefBody<K>;
}

/** @public The body of a blob reference: content address, type and size. */
export interface BlobRefBody {
  /** `artifact://sha256/<hex>`. */
  readonly uri: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * @public
 * Binary content — a screenshot, a recording, a download — stored once in the
 * artifact store (`08-runtime`) and passed around as this small reference.
 */
export interface BlobRef {
  readonly $blob: BlobRefBody;
}

/** @public Spec 08's name for a blob reference; identical to `BlobRef`. */
export type BlobReference = BlobRef;

/**
 * @public
 * A secret, by name: resolved through `environment.secrets` only when the call is
 * sent, never stored, logged or shown to the model, and allowed only in fields a
 * profile marks `sensitive`. JSON: `{ "$secret": "app.password" }`.
 */
export interface Secret<N extends string = string> {
  readonly $secret: N;
}

/**
 * @public
 * What every `effects` operation returns: the action was sent, and when — never
 * whether it worked.
 */
export interface Receipt {
  readonly actionId: string;
  readonly cursor: string | null;
}

/** @public A locator string where an operation expects an element: `'button "Pay"'` (role, then quoted name). */
export type Locator = string;

/** @public A field accepting a ref of kind `K` or a locator, resolved by the server to exactly one thing. */
export type Target<K extends string = string> = Ref<K> | Locator;

const REF_BODY_SHAPE = {
  connection: z.string().min(1),
  id: z.string().min(1),
  seal: z.string().min(1),
} as const;

/** @public Zod schema for any `Ref`. */
export const RefSchema: z.ZodType<Ref, Ref> = z
  .object({
    $ref: z
      .object({
        ...REF_BODY_SHAPE,
        kind: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/** @public Zod schema for a `Ref` of one kind. */
export function refSchemaOf<K extends string>(kind: K): z.ZodType<Ref<K>, Ref<K>> {
  return z
    .object({
      $ref: z
        .object({
          ...REF_BODY_SHAPE,
          kind: z.literal(kind),
        })
        .strict(),
    })
    .strict();
}

/** @public Zod schema for a `BlobRef`. */
export const BlobRefSchema: z.ZodType<BlobRef, BlobRef> = z
  .object({
    $blob: z
      .object({
        uri: z.string().min(1),
        mimeType: z.string().min(1),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict();

/** @public Zod schema for a `Secret`. */
export const SecretSchema: z.ZodType<Secret, Secret> = z
  .object({
    $secret: z.string().min(1),
  })
  .strict();

/** @public Zod schema for a `Receipt`. */
export const ReceiptSchema: z.ZodType<Receipt, Receipt> = z.object({
  actionId: z.string().min(1),
  cursor: z.string().nullable(),
});

/**
 * @public
 * Names a secret for a `sensitive` field. Resolved through `environment.secrets`
 * immediately before the call is sent.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` when `name` is empty.
 */
export function secret<const N extends string>(name: N): Secret<N> {
  if (name.length === 0) {
    throw new NoeticConfigError({
      code: 'CONNECTION_INVALID',
      message: 'secret() needs a name.',
      hint: "Pass the name environment.secrets resolves, e.g. secret('app.password').",
    });
  }
  return {
    $secret: name,
  };
}

function hasObjectKey(value: unknown, key: string): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && key in value;
}

/** @public Whether `value` is a well-formed `Ref`. */
export function isRef(value: unknown): value is Ref {
  return hasObjectKey(value, '$ref') && RefSchema.safeParse(value).success;
}

/** @public Whether `value` is a well-formed `BlobRef`. */
export function isBlobRef(value: unknown): value is BlobRef {
  return hasObjectKey(value, '$blob') && BlobRefSchema.safeParse(value).success;
}

/** @public Whether `value` is a well-formed `Secret`. */
export function isSecret(value: unknown): value is Secret {
  return hasObjectKey(value, '$secret') && SecretSchema.safeParse(value).success;
}

/** @public The id inside a ref (`$refId(x)` in an expression). */
export function refId(ref: Ref): string {
  return ref.$ref.id;
}

//#endregion
