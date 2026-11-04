/**
 * Context layers on an ACP turn, as on a `callModel` call: the user input goes
 * through the layers' append pipeline, recall runs before the turn and its
 * output reaches the agent in the prompt, and the after-call hooks see the
 * turn's result.
 *
 * A model receives layer output as items in its request. An agent takes only a
 * prompt, so each turn's recall is rendered into it as a `<context>` block.
 */

import type {
  Context,
  ContextData,
  ContextLayer,
  ContextRerenderRequest,
  Item,
  ProjectionPolicy,
} from '@noetic-tools/types';
import { DEFAULT_PROJECTION } from './action-deps';
import { computeBudgetMap, gatherRecallResults } from './execute-action';

//#region Helpers

function itemText(item: Item): string {
  if (item.type !== 'message') {
    return '';
  }
  return item.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

//#endregion

//#region Public API

/**
 * Run the layers' recall for this turn and render its output as the block the
 * agent's prompt starts with, or `''` when the layers have nothing to say.
 */
export async function renderLayerContext(params: {
  ctx: Context<ContextData>;
  layers: ContextLayer[] | undefined;
  query: string;
  rerenderRequests: ContextRerenderRequest[];
}): Promise<string> {
  const { ctx, layers } = params;
  if (!layers || layers.length === 0) {
    return '';
  }
  const policy: ProjectionPolicy = ctx.harness.config.projection ?? DEFAULT_PROJECTION;
  const recall = await gatherRecallResults({
    ctx,
    layers,
    recallQuery: params.query,
    budgetMap: computeBudgetMap({
      layers,
      policy,
      systemPromptTokens: 0,
    }),
    slotOf: new Map(
      layers.map((layer) => [
        layer.id,
        layer.slot,
      ]),
    ),
    rerenderRequests: params.rerenderRequests,
  });
  const text = recall
    .flatMap((output) => output.items)
    .map(itemText)
    .filter((chunk) => chunk.trim().length > 0)
    .join('\n\n');
  return text.length > 0 ? `<context>\n${text}\n</context>` : '';
}

//#endregion
