import type { ZodTypeAny } from 'zod';
import { z } from 'zod';

/**
 * Item schemas that let a log accept the final items of these custom item types
 * (spec 34). They gate on `type` and `id` only: an emitter checks an item's fields
 * against its declared `output` before appending it, and a restore reads back items
 * that were checked when they were emitted.
 */
export function customItemGates(types: Iterable<string>): ZodTypeAny[] {
  return [
    ...new Set(types),
  ].map((type) =>
    z.looseObject({
      type: z.literal(type),
      id: z.string(),
    }),
  );
}
