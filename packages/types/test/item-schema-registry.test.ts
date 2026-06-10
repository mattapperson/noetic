import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { isNoeticError } from '../src/errors/noetic-error';
import { ItemSchemaRegistry } from '../src/schemas/item';
import type { Item } from '../src/types/items';
import { frameworkCast } from '../src/util/framework-cast';

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected fn to throw');
}

/** Type the raw fixture as `Item` for comparison against registry output. */
function asItem(value: unknown): Item {
  return frameworkCast<Item>(value);
}

describe('ItemSchemaRegistry — gate, not normalizer', () => {
  it('parse() returns the ORIGINAL value on extension match, including undeclared fields', () => {
    const registry = new ItemSchemaRegistry({
      items: [
        z.object({
          type: z.literal('custom:notice'),
          text: z.string(),
        }),
      ],
    });
    const original = asItem({
      type: 'custom:notice',
      text: 'hello',
      id: 'n-1',
      status: 'completed',
      annotations: [
        'keep-me',
      ],
    });

    const parsed = registry.parse(original);

    expect(parsed).toBe(original);
    expect(parsed).toEqual(
      asItem({
        type: 'custom:notice',
        text: 'hello',
        id: 'n-1',
        status: 'completed',
        annotations: [
          'keep-me',
        ],
      }),
    );
  });

  it('parseWithCategory() returns the ORIGINAL value on category match, including undeclared fields', () => {
    const registry = new ItemSchemaRegistry({
      toolResults: [
        z.object({
          type: z.literal('function_call_output'),
          callId: z.string(),
          output: z.string(),
        }),
      ],
    });
    const original = asItem({
      type: 'function_call_output',
      callId: 'call-1',
      output: '{}',
      id: 'framework-id',
      status: 'completed',
    });

    const parsed = registry.parseWithCategory(original, 'toolResults');

    expect(parsed).toBe(original);
    expect(parsed).toEqual(
      asItem({
        type: 'function_call_output',
        callId: 'call-1',
        output: '{}',
        id: 'framework-id',
        status: 'completed',
      }),
    );
  });

  it('does not apply .transform() declared in an extension schema (transforms unsupported)', () => {
    const registry = new ItemSchemaRegistry({
      items: [
        z
          .object({
            type: z.literal('custom:notice'),
            text: z.string(),
          })
          .transform((v) => ({
            ...v,
            text: v.text.toUpperCase(),
          })),
      ],
    });
    const original = asItem({
      type: 'custom:notice',
      text: 'lowercase',
    });

    const parsed = registry.parse(original);

    expect(parsed).toBe(original);
    expect(parsed).toEqual(
      asItem({
        type: 'custom:notice',
        text: 'lowercase',
      }),
    );
  });

  it('does not apply .default() declared in an extension schema (defaults unsupported)', () => {
    const registry = new ItemSchemaRegistry({
      toolResults: [
        z.object({
          type: z.literal('function_call_output'),
          callId: z.string(),
          output: z.string(),
          severity: z.string().default('info'),
        }),
      ],
    });
    const original = asItem({
      type: 'function_call_output',
      callId: 'call-1',
      output: 'ok',
    });

    const parsed = registry.parseWithCategory(original, 'toolResults');

    expect(parsed).toBe(original);
    expect('severity' in parsed).toBe(false);
  });
});

describe('ItemSchemaRegistry — item_schema_mismatch errors', () => {
  it('parseWithCategory() throws kind item_schema_mismatch with the category on no match', () => {
    const registry = new ItemSchemaRegistry({
      toolResults: [
        z.object({
          type: z.literal('function_call_output'),
          callId: z.string(),
          output: z.string(),
          card: z.object({
            title: z.string(),
          }),
        }),
      ],
    });

    const e = captureError(() =>
      registry.parseWithCategory(
        {
          type: 'function_call_output',
          callId: 'call-1',
          output: '{}',
        },
        'toolResults',
      ),
    );

    assert(isNoeticError(e));
    expect(e.noeticError.kind).toBe('item_schema_mismatch');
    assert(e.noeticError.kind === 'item_schema_mismatch');
    expect(e.noeticError.category).toBe('toolResults');
    expect(e.noeticError.itemType).toBeUndefined();
    expect(e.message).toContain('toolResults');
  });

  it('strict unknown-extension rejection throws kind item_schema_mismatch with the item type', () => {
    const registry = new ItemSchemaRegistry({
      items: [
        z.object({
          type: z.literal('custom:known'),
        }),
      ],
    });

    const e = captureError(() =>
      registry.parse({
        type: 'custom:unknown',
      }),
    );

    assert(isNoeticError(e));
    expect(e.noeticError.kind).toBe('item_schema_mismatch');
    assert(e.noeticError.kind === 'item_schema_mismatch');
    expect(e.noeticError.category).toBe('items');
    expect(e.noeticError.itemType).toBe('custom:unknown');
    expect(e.message).toContain('custom:unknown');
  });

  it('parseWithCategory() with no category schemas falls back to base parse', () => {
    const registry = new ItemSchemaRegistry();
    const original = asItem({
      type: 'function_call_output',
      callId: 'call-1',
      output: 'ok',
      id: 'id-1',
      status: 'completed',
    });

    expect(registry.parseWithCategory(original, 'toolResults')).toBe(original);
  });

  it('known base types still parse when unrelated extension schemas are registered', () => {
    const registry = new ItemSchemaRegistry({
      items: [
        z.object({
          type: z.literal('custom:known'),
        }),
      ],
    });
    const message = asItem({
      type: 'message',
      role: 'assistant',
      content: [],
    });

    expect(registry.parse(message)).toBe(message);
  });
});

describe('ItemSchemaRegistry — extend()', () => {
  it('extend() without schemas returns the same registry instance', () => {
    const registry = new ItemSchemaRegistry();
    expect(registry.extend(undefined)).toBe(registry);
    expect(
      registry.extend({
        toolResults: [],
      }),
    ).toBe(registry);
  });

  it('extend() scopes category schemas to the extended registry only', () => {
    const base = new ItemSchemaRegistry();
    const extended = base.extend({
      toolResults: [
        z.object({
          type: z.literal('function_call_output'),
          callId: z.string(),
          output: z.string(),
          card: z.object({
            title: z.string(),
          }),
        }),
      ],
    });
    const plainResult = asItem({
      type: 'function_call_output',
      callId: 'call-2',
      output: 'plain',
    });

    // The base registry (no toolResults schemas) accepts the plain item…
    expect(base.parseWithCategory(plainResult, 'toolResults')).toBe(plainResult);
    // …while the extended registry rejects it with the typed error.
    const e = captureError(() => extended.parseWithCategory(plainResult, 'toolResults'));
    assert(isNoeticError(e));
    expect(e.noeticError.kind).toBe('item_schema_mismatch');
  });
});
