/**
 * The shared tool-result item path: one builder every tool dispatch uses to
 * turn a tool's output into the transcript's `function_call_output` item —
 * the model tool-loop (`harness/model-call`) and hydrated JSON-workflow
 * `invokeTool` nodes alike — so the item always gets the same treatment
 * regardless of who issued the call: the tool's own `decorateResultItem`
 * hook runs, and the decorated item is validated against the owner-scoped
 * item-schema registry.
 *
 * It lives in `tooling/` (below the harness/builders layers) for the same
 * reason `executeToolCall` does: the JSON workflow hydrator in `builders/`
 * must reach it, and harness → builders is the wrong direction.
 */

import type { Item, ItemSchemaRegistry, Tool } from '@noetic-tools/types';

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
