/**
 * Runtime schema for the `Item` union.
 *
 * The `Item` type is a discriminated union of framework-created items
 * (`InputMessageItem`, `FunctionCallOutputItem`) and provider-shaped items
 * from `@openrouter/agent` whose shapes are defined by the SDK's generated
 * types. Mirroring those provider shapes as Zod schemas would drift as the
 * SDK evolves, so the runtime schema validates only the structural invariant
 * every `Item` shares: an object with a non-empty string `type` discriminant.
 *
 * Use this at trust boundaries (loading persisted session files, accepting
 * externally-supplied transcripts) where we need to reject garbage JSON but
 * don't need to re-validate every provider field TypeScript already types.
 */

import { z } from 'zod';
import type { Item } from '../types/items';

function isItemLike(value: unknown): value is Item {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('type' in value)) {
    return false;
  }
  const { type } = value;
  return typeof type === 'string' && type.length > 0;
}

/** @public Structural validator for `Item`. Asserts non-empty string `type` discriminant. */
export const ItemSchema = z.custom<Item>(isItemLike, {
  message: 'Expected an Item object with a non-empty string "type" discriminant.',
});
