import type { ContextLayer } from '@noetic-tools/context';
import type { ItemSchemaConfig, ItemSchemaExtensions, Tool } from '@noetic-tools/types';
import {
  CONNECTION_EVENT_ITEM_TYPE,
  frameworkCast,
  ItemSchemaRegistry,
  mergeExtensions,
} from '@noetic-tools/types';
import { collectCustomItems } from '../interpreter/emit-items';
import { customItemGates } from '../runtime/item-gates';
import type { ContextData, Step } from './deps/types';

function mergeItemSchemaExtensions(
  extensions: ReadonlyArray<ItemSchemaExtensions | undefined>,
): ItemSchemaExtensions {
  let result: ItemSchemaExtensions = {
    items: [],
    developerMessages: [],
    toolCalls: [],
    toolResults: [],
  };
  for (const ext of extensions) {
    if (ext) {
      result = mergeExtensions(result, ext);
    }
  }
  return result;
}

function collectLayerItemSchemaExtensions(layers: ReadonlyArray<ContextLayer> | undefined) {
  return mergeItemSchemaExtensions(layers?.map((layer) => layer.itemSchemas) ?? []);
}

function collectToolItemSchemaExtensions(tools: ReadonlyArray<Tool> | undefined) {
  return mergeItemSchemaExtensions(tools?.map((tool) => tool.itemSchemas) ?? []);
}

export function buildItemSchemaRegistry({
  base,
  layers,
  tools,
}: {
  base: ItemSchemaRegistry;
  layers?: ReadonlyArray<ContextLayer>;
  tools?: ReadonlyArray<Tool>;
}): ItemSchemaRegistry {
  return base
    .extend(collectLayerItemSchemaExtensions(layers))
    .extend(collectToolItemSchemaExtensions(tools));
}

export function harnessItemSchemas(
  graph: Step<ContextData, string, string> | undefined,
  options: ItemSchemaConfig | undefined,
): ItemSchemaRegistry {
  // The graph's custom items join before any log is restored or rebuilt (spec 34).
  return new ItemSchemaRegistry(options?.schemas, {
    strictUnknownExtensions: options?.strict ?? true,
  }).extend({
    items: customItemGates([
      ...(graph ? collectCustomItems(frameworkCast<Step>(graph)).map((item) => item.type) : []),
      // Always known: a trigger can be added while the harness runs, and one added
      // on an earlier run comes back from storage, so its turns must be able to
      // carry the event.
      CONNECTION_EVENT_ITEM_TYPE,
    ]),
  });
}
