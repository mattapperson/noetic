import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { WorkflowDocument, WorkflowNode } from '../schemas/workflow';
import type { FrameworkStreamEvent } from './harness-result';
import type { InferSchemaOutput } from './schema';

//#region JSON Schema

/**
 * A JSON Schema object. Write it `as const` to give `FromJsonSchema` its literal
 * shape; a schema typed as plain `JsonSchema` maps to `Record<string, unknown>`.
 * @public
 */
export type JsonSchema = {
  readonly [key: string]: unknown;
};

type JsonPrimitive = {
  string: string;
  number: number;
  integer: number;
  boolean: boolean;
  null: null;
};

type FromTypeName<T> = T extends keyof JsonPrimitive ? JsonPrimitive[T] : unknown;

type Simplify<T> = {
  [K in keyof T]: T[K];
} & {};

type FromProperties<P, R> = Simplify<
  {
    -readonly [K in keyof P as K extends R ? K : never]: FromJsonSchema<P[K]>;
  } & {
    -readonly [K in keyof P as K extends R ? never : K]?: FromJsonSchema<P[K]>;
  }
>;

type FromObject<S> = S extends {
  readonly properties: infer P;
}
  ? FromProperties<
      P,
      S extends {
        readonly required: ReadonlyArray<infer R>;
      }
        ? R
        : never
    >
  : Record<string, unknown>;

type FromTyped<S, T> = T extends 'object'
  ? FromObject<S>
  : T extends 'array'
    ? S extends {
        readonly items: infer I;
      }
      ? FromJsonSchema<I>[]
      : unknown[]
    : FromTypeName<T>;

/**
 * The type an `as const` JSON Schema describes. Covers primitives, `enum`, `const`,
 * arrays, objects (with `required`), `anyOf`/`oneOf`, and `type` arrays; anything
 * else is `unknown`, which validation still checks at run time. See spec 34.
 * @public
 */
export type FromJsonSchema<S> = string extends keyof S
  ? Record<string, unknown>
  : S extends {
        readonly const: infer C;
      }
    ? C
    : S extends {
          readonly enum: ReadonlyArray<infer E>;
        }
      ? E
      : S extends {
            readonly anyOf: ReadonlyArray<infer A>;
          }
        ? FromJsonSchema<A>
        : S extends {
              readonly oneOf: ReadonlyArray<infer A>;
            }
          ? FromJsonSchema<A>
          : S extends {
                readonly type: ReadonlyArray<infer T>;
              }
            ? FromTyped<S, T>
            : S extends {
                  readonly type: infer T;
                }
              ? FromTyped<S, T>
              : unknown;

//#endregion

//#region Workflow Documents

/** @public A value with every nested property and array made readonly, as `as const` gives. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer E>
    ? ReadonlyArray<DeepReadonly<E>>
    : T extends object
      ? {
          readonly [K in keyof T]: DeepReadonly<T[K]>;
        }
      : T;

type JsonDeclaredItems<C> = {
  [N in keyof C]: C[N] extends {
    readonly type: infer T extends CustomItemType;
    readonly output: infer O;
  }
    ? CustomItem<
        T,
        C[N] extends {
          readonly event: infer E;
        }
          ? FromJsonSchema<E>
          : never,
        FromJsonSchema<O>
      >
    : never;
}[keyof C];

type Depth = readonly unknown[];

/**
 * Every custom item an `as const` workflow document declares, at its root, on any
 * node, or in an inline subflow, as `CustomItem`s typed from their JSON Schema. A
 * document typed as the plain `WorkflowDocument` (not a literal) declares none here;
 * its items are checked at run time only.
 * @public
 */
export type DocumentCustomItems<D> = WorkflowDocument extends D ? never : CollectItems<D>;

type CollectItems<D, L extends Depth = []> = L['length'] extends 16
  ? never
  : WorkflowNode extends D
    ? never
    : D extends ReadonlyArray<infer E>
      ? CollectItems<
          E,
          readonly [
            ...L,
            0,
          ]
        >
      : D extends object
        ?
            | (D extends {
                readonly customItems: infer C;
              }
                ? string extends keyof C
                  ? never
                  : JsonDeclaredItems<C>
                : never)
            | {
                [K in Exclude<keyof D, 'customItems'>]: CollectItems<
                  D[K],
                  readonly [
                    ...L,
                    0,
                  ]
                >;
              }[Exclude<keyof D, 'customItems'>]
        : never;

//#endregion

//#region Custom Item

/** @public A custom item's schema: any Standard Schema (Zod, Valibot, …) or a JSON Schema object. */
export type ItemShape = StandardSchemaV1 | JsonSchema;

/** @public The value an `ItemShape` describes. */
export type InferShape<S> = S extends StandardSchemaV1
  ? InferSchemaOutput<S>
  : S extends JsonSchema
    ? FromJsonSchema<S>
    : never;

/** @public An extension item type, named `prefix:name` after the Open Responses convention. */
export type CustomItemType = `${string}:${string}`;

/**
 * A declared custom item (spec 34): what a workflow may emit besides the standard
 * items. `E` is an event's payload, `O` the final item's own fields. Build one with
 * `customItem()`.
 * @public
 */
export interface CustomItem<T extends CustomItemType = CustomItemType, E = unknown, O = unknown> {
  readonly type: T;
  readonly description?: string;
  /** Validates each event. Absent when the item has no events. */
  readonly event?: StandardSchemaV1<unknown, E>;
  /** Validates the final item's fields. */
  readonly output: StandardSchemaV1<unknown, O>;
}

/** @public Declared custom items, by the name steps emit them under. */
export type CustomItemMap = {
  readonly [name: string]: CustomItem;
};

/** @public The final form of a custom item: its fields plus the `id` and `type` the runtime adds. */
export type CustomItemOf<C> =
  C extends CustomItem<infer T, unknown, infer O>
    ? Simplify<
        {
          id: string;
          type: T;
        } & O
      >
    : never;

/** @public One event of a custom item, tied to its final item by `id`. */
export type CustomItemEventOf<C> =
  C extends CustomItem<infer T, infer E, unknown>
    ? {
        id: string;
        type: T;
        event: E;
      }
    : never;

/**
 * A custom item as `getItemStream()` yields it: each event in progress, then the
 * final item. `isComplete` tells them apart; both carry the same `id`.
 * @public
 */
export type CustomStreamingItem<C> =
  | (CustomItemEventOf<C> & {
      isComplete: false;
    })
  | (CustomItemOf<C> & {
      isComplete: true;
    });

/** @public The raw `custom_item_event` framework event `getFullStream()` yields for each event. */
export type CustomItemStreamEvent<C> = FrameworkStreamEvent & {
  readonly data: CustomItemEventOf<C>;
};

/**
 * The declared custom items in `T`, or none when `T` is the wide `CustomItem` that an
 * undeclared step carries.
 * @public
 */
export type DeclaredItems<T> = CustomItem extends T ? never : T;

/**
 * The type-only brand that carries the custom items a step can emit, so a harness can
 * read them off its `agentGraph`. Kept apart from `customItems`, whose wide
 * `CustomItemMap` type every step shares.
 * @public
 */
export interface CustomItemsBrand<C> {
  readonly '~customItems'?: C;
}

//#endregion

//#region Guards

/**
 * The members of `V` that are `U`, or `V & U` when none are: a typed harness's
 * results hold the custom members already, an untyped value gains them.
 */
type Narrowed<V, U> = [
  Extract<V, U>,
] extends [
  never,
]
  ? V & U
  : Extract<V, U>;

/**
 * Narrows a harness result to one declared custom item: an item from
 * `getItemStream()` to that item's events or final form, an item from
 * `getAgentResponse()` to its final form. Comparing `item.type` alone cannot narrow
 * it, because standard server-tool items share the `prefix:name` type space.
 * @public
 */
export function isCustomItem<V, C extends CustomItem>(
  value: V,
  item: C,
): value is Narrowed<V, CustomItemOf<C> | CustomStreamingItem<C>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === item.type &&
    'id' in value
  );
}

/**
 * Narrows a `getFullStream()` event to one declared custom item's raw
 * `custom_item_event`, typing its `data.event`.
 * @public
 */
export function isCustomItemEvent<V extends FrameworkStreamEvent | object, C extends CustomItem>(
  event: V,
  item: C,
): event is Narrowed<V, CustomItemStreamEvent<C>> {
  if (!('type' in event) || typeof event.type !== 'string') {
    return false;
  }
  if (!event.type.endsWith(':custom_item_event') || !('data' in event)) {
    return false;
  }
  const data = event.data;
  return typeof data === 'object' && data !== null && 'type' in data && data.type === item.type;
}

//#endregion
