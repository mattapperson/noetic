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
  ContextObservation,
  ContextRerenderRequest,
  Item,
  ProjectionPolicy,
} from '@noetic-tools/types';
import { DEFAULT_PROJECTION } from './action-deps';
import { computeBudgetMap, gatherRecallResults } from './context-assembly';

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
  observation?: ContextObservation;
}): Promise<{
  text: string;
  layerText: Record<string, string>;
}> {
  const { ctx, layers } = params;
  if (!layers || layers.length === 0) {
    return {
      text: '',
      layerText: {},
    };
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
    observation: params.observation,
  });
  const rendered = recall.map(({ layerId, items }) => ({
    layerId,
    text: items
      .map(itemText)
      .filter((chunk) => chunk.trim().length > 0)
      .join('\n\n'),
  }));
  const text = rendered
    .map((entry) => entry.text)
    .filter(Boolean)
    .join('\n\n');
  const layerText = Object.fromEntries(
    rendered.map((entry) => [
      entry.layerId,
      entry.text,
    ]),
  );
  return {
    text: text.length > 0 ? `<context>\n${text}\n</context>` : '',
    layerText,
  };
}

//#endregion
