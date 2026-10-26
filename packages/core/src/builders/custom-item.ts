import type {
  CustomItem,
  CustomItemMap,
  CustomItemType,
  InferShape,
  ItemShape,
  StandardSchemaV1,
} from '@noetic-tools/types';
import { frameworkCast, isZodSchema, NoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';

//#region Types

interface CustomItemConfig<T extends CustomItemType, E extends ItemShape, O extends ItemShape> {
  /** `prefix:name`, after the Open Responses convention for extension items. */
  type: T;
  description?: string;
  /** What streams while a step works on the item. Omit for an item with no events. */
  event?: E;
  /** The final item's own fields. The runtime adds `id` and `type`. */
  output: O;
}

//#endregion

//#region Public API

/**
 * Declares a custom item a workflow may emit (spec 34), shaped like `tool()`: an
 * optional `event` schema for what streams and an `output` schema for the final
 * item. Each takes a Standard Schema or a JSON Schema object; a JSON Schema
 * validates through `z.fromJSONSchema`, so no code is generated.
 *
 * @public
 * @throws `NoeticConfigError` with code `INVALID_CUSTOM_ITEM_TYPE` when `type` has no `prefix:` part.
 * @throws `NoeticConfigError` with code `INVALID_CUSTOM_ITEM_SHAPE` when a JSON Schema does not
 * load, or `output` does not describe an object or declares `id` or `type`.
 */
export function customItem<
  T extends CustomItemType,
  O extends ItemShape,
  E extends ItemShape = never,
>(config: CustomItemConfig<T, E, O>): CustomItem<T, InferShape<E>, InferShape<O>> {
  if (!/^[^:]+:.+$/.test(config.type)) {
    throw new NoeticConfigError({
      code: 'INVALID_CUSTOM_ITEM_TYPE',
      message: `Custom item type '${config.type}' has no 'prefix:' part.`,
      hint: "Name it 'prefix:name' after the Open Responses convention, e.g. 'myapp:progress'.",
    });
  }
  const output = toSchema(config.output, config.type, 'output');
  checkFields(output, config.type);
  return {
    type: config.type,
    description: config.description,
    event:
      config.event === undefined
        ? undefined
        : frameworkCast<StandardSchemaV1<unknown, InferShape<E>>>(
            toSchema(config.event, config.type, 'event'),
          ),
    output: frameworkCast<StandardSchemaV1<unknown, InferShape<O>>>(output),
  };
}

/**
 * @internal
 * Build-time checks on a programmatic step's `emitItems`: a named item must be one the
 * step declares, and a step that yields events (a generator `execute`) must name an
 * item that has them.
 *
 * @throws `NoeticConfigError` with code `UNKNOWN_CUSTOM_ITEM` or `CUSTOM_ITEM_HAS_NO_EVENTS`.
 */
export function checkEmitItems(
  stepId: string,
  step: {
    emitItems?: unknown;
    customItems?: CustomItemMap;
  },
  yields: boolean,
): void {
  const name = emitItemName(step.emitItems);
  if (name !== undefined && !step.customItems?.[name]) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_CUSTOM_ITEM',
      message: `Step '${stepId}' emits custom item '${name}', which it does not declare.`,
      hint: `Declare it on the step: customItems: { ${name}: customItem({ type: 'myapp:${name}', output }) }.`,
    });
  }
  if (!yields) {
    return;
  }
  if (name === undefined || !step.customItems?.[name]?.event) {
    throw new NoeticConfigError({
      code: 'CUSTOM_ITEM_HAS_NO_EVENTS',
      message: `Step '${stepId}' yields events, but ${name === undefined ? 'its emitItems names no item' : `custom item '${name}' declares no event schema`}.`,
      hint: "Name an item with an event schema: emitItems: { item: 'progress' }, with customItem({ type, event, output }).",
    });
  }
}

/** @internal True for a `function*` or `async function*`. */
export function isGeneratorFunction(fn: unknown): boolean {
  const name = typeof fn === 'function' ? fn.constructor.name : '';
  return name === 'GeneratorFunction' || name === 'AsyncGeneratorFunction';
}

//#endregion

//#region Helpers

function emitItemName(option: unknown): string | undefined {
  if (typeof option !== 'object' || option === null || !('item' in option)) {
    return undefined;
  }
  return typeof option.item === 'string' ? option.item : undefined;
}

function toSchema(shape: ItemShape, type: string, part: 'event' | 'output'): StandardSchemaV1 {
  if (isStandardSchema(shape)) {
    return shape;
  }
  try {
    return z.fromJSONSchema(frameworkCast<z.core.JSONSchema.JSONSchema>(shape));
  } catch (error) {
    throw new NoeticConfigError({
      code: 'INVALID_CUSTOM_ITEM_SHAPE',
      message: `The ${part} JSON Schema of custom item '${type}' does not load: ${error instanceof Error ? error.message : String(error)}`,
      hint: 'Give a JSON Schema object (draft 2020-12), e.g. { "type": "object", "properties": { … } }.',
    });
  }
}

function isStandardSchema(shape: ItemShape): shape is StandardSchemaV1 {
  return '~standard' in shape;
}

/**
 * The fields check needs a schema it can see into: a Zod object, which every JSON
 * Schema becomes. Other vendors are checked when a value is emitted instead.
 */
function checkFields(output: StandardSchemaV1, type: string): void {
  if (!isZodSchema(output)) {
    return;
  }
  if (!(output instanceof z.ZodObject)) {
    throw new NoeticConfigError({
      code: 'INVALID_CUSTOM_ITEM_SHAPE',
      message: `The output of custom item '${type}' does not describe an object.`,
      hint: 'A final item is its fields plus the id and type the runtime adds, so output must be an object schema.',
    });
  }
  const reserved = Object.keys(output.shape).filter((key) => key === 'id' || key === 'type');
  if (reserved.length > 0) {
    throw new NoeticConfigError({
      code: 'INVALID_CUSTOM_ITEM_SHAPE',
      message: `The output of custom item '${type}' declares ${reserved.map((key) => `'${key}'`).join(' and ')}, which the runtime adds.`,
      hint: 'Drop id and type from the output schema; every final item gets both.',
    });
  }
}

//#endregion
