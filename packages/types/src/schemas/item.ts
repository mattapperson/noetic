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
 *
 * Extension schemas registered on the registry are **gates, not
 * normalizers**: they validate item shape and the ORIGINAL value is returned
 * on match. Zod transforms, defaults, and key-stripping in extension schemas
 * are unsupported — their output is discarded. Declare pure shape validators.
 */

import { z } from 'zod';
import { NoeticErrorImpl } from '../errors/noetic-error';
import type { Item, ItemSchemaExtensions } from '../types/items';

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

type ItemSchemaCategory = keyof Required<ItemSchemaExtensions>;

function hasSchemas(extensions: ItemSchemaExtensions): boolean {
  return Boolean(
    extensions.items?.length ||
      extensions.developerMessages?.length ||
      extensions.toolCalls?.length ||
      extensions.toolResults?.length,
  );
}

export function mergeExtensions(
  a: ItemSchemaExtensions | undefined,
  b: ItemSchemaExtensions | undefined,
): ItemSchemaExtensions {
  return {
    items: [
      ...(a?.items ?? []),
      ...(b?.items ?? []),
    ],
    developerMessages: [
      ...(a?.developerMessages ?? []),
      ...(b?.developerMessages ?? []),
    ],
    toolCalls: [
      ...(a?.toolCalls ?? []),
      ...(b?.toolCalls ?? []),
    ],
    toolResults: [
      ...(a?.toolResults ?? []),
      ...(b?.toolResults ?? []),
    ],
  };
}

function schemasForCategory(
  extensions: ItemSchemaExtensions,
  category: ItemSchemaCategory,
): NonNullable<ItemSchemaExtensions[ItemSchemaCategory]> {
  return extensions[category] ?? [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function relevantCategories(value: unknown): ItemSchemaCategory[] {
  const categories: ItemSchemaCategory[] = [
    'items',
  ];
  if (isRecord(value) && value.type === 'message' && value.role === 'developer') {
    categories.push('developerMessages');
  }
  if (isRecord(value) && value.type === 'function_call') {
    categories.push('toolCalls');
  }
  if (isRecord(value) && value.type === 'function_call_output') {
    categories.push('toolResults');
  }
  return categories;
}

function isKnownBaseType(type: string): boolean {
  return (
    type === 'message' ||
    type === 'function_call' ||
    type === 'function_call_output' ||
    type === 'reasoning' ||
    type === 'web_search_call' ||
    type === 'file_search_call' ||
    type === 'image_generation_call' ||
    type.startsWith('openrouter:')
  );
}

function schemaMismatch(category: ItemSchemaCategory): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'item_schema_mismatch',
    category,
  });
}

/**
 * @public Runtime item validator with optional tool, memory-layer, and harness extension schemas.
 *
 * Extension schemas are pure shape validators (gate, not normalizer): on
 * match the original value is returned unchanged, including fields the schema
 * does not declare. Transforms and defaults in extension schemas are
 * unsupported — their parsed output is never used.
 */
export class ItemSchemaRegistry {
  readonly extensions: ItemSchemaExtensions;
  readonly strictUnknownExtensions: boolean;

  constructor(
    extensions?: ItemSchemaExtensions,
    opts?: {
      strictUnknownExtensions?: boolean;
    },
  ) {
    this.extensions = mergeExtensions(undefined, extensions);
    this.strictUnknownExtensions = opts?.strictUnknownExtensions ?? true;
  }

  extend(extensions?: ItemSchemaExtensions): ItemSchemaRegistry {
    if (!extensions || !hasSchemas(extensions)) {
      return this;
    }
    return new ItemSchemaRegistry(mergeExtensions(this.extensions, extensions), {
      strictUnknownExtensions: this.strictUnknownExtensions,
    });
  }

  parse(value: unknown): Item {
    const base = ItemSchema.parse(value);
    const categories = relevantCategories(base);
    const schemas = categories.flatMap((category) => schemasForCategory(this.extensions, category));

    for (const schema of schemas) {
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        // Gate, not normalizer: return the original value, not the
        // zod-stripped clone, so undeclared fields survive validation.
        return base;
      }
    }

    if (this.strictUnknownExtensions && !isKnownBaseType(base.type)) {
      throw new NoeticErrorImpl({
        kind: 'item_schema_mismatch',
        category: 'items',
        itemType: base.type,
      });
    }

    return base;
  }

  parseMany(values: Iterable<unknown>): Item[] {
    return Array.from(values, (value) => this.parse(value));
  }

  /**
   * Validate `value` against the schemas registered for `category` only.
   *
   * When no schemas are registered for the category, falls back to
   * `parse()`. Throws a `NoeticErrorImpl` with kind `item_schema_mismatch`
   * when schemas exist for the category and none match.
   */
  parseWithCategory(value: unknown, category: ItemSchemaCategory): Item {
    const schemas = schemasForCategory(this.extensions, category);
    if (schemas.length === 0) {
      return this.parse(value);
    }
    for (const schema of schemas) {
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        // Gate, not normalizer: validate shape, return the original value.
        return ItemSchema.parse(value);
      }
    }
    throw schemaMismatch(category);
  }
}

/** @public Default item schema registry. */
export const defaultItemSchemaRegistry = new ItemSchemaRegistry(undefined, {
  strictUnknownExtensions: true,
});
