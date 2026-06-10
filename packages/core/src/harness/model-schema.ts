import type { MemoryLayer } from '@noetic-tools/memory';
import type { Item, ItemSchemaExtensions, ItemSchemaRegistry, Tool } from '@noetic-tools/types';
import { mergeExtensions } from '@noetic-tools/types';

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

function collectLayerItemSchemaExtensions(layers: ReadonlyArray<MemoryLayer> | undefined) {
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
  layers?: ReadonlyArray<MemoryLayer>;
  tools?: ReadonlyArray<Tool>;
}): ItemSchemaRegistry {
  return base
    .extend(collectLayerItemSchemaExtensions(layers))
    .extend(collectToolItemSchemaExtensions(tools));
}

/**
 * Build and validate a `function_call_output` item for a tool result.
 *
 * `roundItemSchemas` must be the OWNER-SCOPED registry for the called tool
 * (harness base extended with only that tool's `itemSchemas`), so one tool's
 * `toolResults` schemas never reject a sibling tool's result items. Tools
 * without `itemSchemas` fall back to the base structural parse.
 */
export function createToolResultItem({
  output,
  callId,
  roundItemSchemas,
  tool,
  callItem,
  args,
  result,
  error,
}: {
  output: string;
  callId: string;
  roundItemSchemas: ItemSchemaRegistry;
  tool?: Tool;
  callItem?: Item;
  args?: unknown;
  result?: unknown;
  error?: boolean;
}): Item {
  const baseItem = {
    id: crypto.randomUUID(),
    status: 'completed',
    type: 'function_call_output',
    callId,
    output,
  } as const;
  const decorated =
    tool?.decorateResultItem && callItem?.type === 'function_call'
      ? tool.decorateResultItem({
          baseItem,
          callItem,
          args,
          result,
          output,
          error,
        })
      : baseItem;
  return roundItemSchemas.parseWithCategory(decorated, 'toolResults');
}
