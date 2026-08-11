'use client';

/**
 * One memory layer's live view: identity badges (slot, scope, budget), the
 * items + token count it contributed to the last model call, and its raw
 * state. Refetches when the layer's change counter bumps (layer_state SSE)
 * while the tab is visible.
 *
 * `history` gets a dedicated view: it is projection-only
 * (`ContextLayer<null>` — conversation history is not a context layer), so
 * instead of printing `null` the tab shows the recent session items the
 * layer will trim into the next window.
 */

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { idOf, roleOf, textOf } from '../../lib/items';
import { useInspector } from '../../lib/store';
import type { LayerInfo, LayerStateResult, StreamingItem } from '../../server/wire-types';
import { JsonView } from './JsonView';

const HISTORY_PREVIEW_ITEMS = 20;

function Badge({ label }: { label: string }) {
  return (
    <span className="rounded-chip bg-inset px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2 shadow-hairline">
      {label}
    </span>
  );
}

function budgetLabel(layer: LayerInfo): string | null {
  if (layer.budget === undefined) {
    return null;
  }
  if (typeof layer.budget === 'number') {
    return `budget ${layer.budget}`;
  }
  if (layer.budget === 'auto') {
    return 'budget auto';
  }
  return `budget ${layer.budget.min}–${layer.budget.max}`;
}

function HistoryWindowView() {
  const order = useInspector((state) => state.order);
  const itemsById = useInspector((state) => state.itemsById);
  const usage = useInspector((state) => state.usage);

  const recent = order
    .slice(-HISTORY_PREVIEW_ITEMS)
    .map((id) => itemsById[id])
    .filter((item): item is StreamingItem => item !== undefined);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line px-3 py-2">
        <p className="text-[11.5px] leading-relaxed text-ink-2">
          This layer stores nothing — conversation history is not a memory layer. It runs at
          projection time, trimming session history to budget as the context window is assembled
          {usage !== undefined ? ` (${usage.historyTokens} history tokens in the last call)` : ''}.
          Below are the most recent session items feeding it; the Context tab shows the exact
          assembled window.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {recent.length === 0 && (
          <p className="p-2 text-[12.5px] text-ink-3">No session history yet.</p>
        )}
        {recent.map((item) => {
          const text = textOf(item);
          return (
            <div
              key={idOf(item)}
              className="flex items-baseline gap-2 border-b border-line px-1.5 py-1"
            >
              <span className="shrink-0 rounded-chip bg-inset px-1.5 py-px font-mono text-[10px] text-ink-2 shadow-hairline">
                {roleOf(item)}
              </span>
              <span className="min-w-0 truncate text-[11.5px] text-ink-2">
                {text.length > 0 ? text : item.type}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function LayerTab({ layer }: { layer: LayerInfo }) {
  const version = useInspector((state) => state.layerVersions[layer.id] ?? 0);
  const usage = useInspector((state) => state.usage);
  const [result, setResult] = useState<LayerStateResult | null>(null);
  const isHistoryLayer = layer.id === 'history';

  useEffect(() => {
    if (isHistoryLayer) {
      return;
    }
    void api
      .layerState(layer.id, version)
      .then(setResult)
      .catch(() => setResult(null));
  }, [
    layer.id,
    version,
    isHistoryLayer,
  ]);

  const layerUsage = usage?.layers.find((entry) => entry.layerId === layer.id);
  const budget = budgetLabel(layer);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        <span className="text-[13px] font-medium text-ink">{layer.name ?? layer.id}</span>
        <Badge label={`slot ${layer.slot}`} />
        <Badge label={layer.scope} />
        {budget !== null && <Badge label={budget} />}
        {layerUsage !== undefined && <Badge label={`${layerUsage.tokenCount} tok last call`} />}
        {!isHistoryLayer && result !== null && result.source !== 'live' && (
          <Badge label={result.source} />
        )}
      </div>
      {isHistoryLayer ? (
        <HistoryWindowView />
      ) : (
        <>
          {layerUsage !== undefined && layerUsage.items.length > 0 && (
            <div className="shrink-0 border-b border-line px-3 py-2">
              <p className="text-[11.5px] font-medium text-ink-2">
                Injected into the last model call
              </p>
              <JsonView value={layerUsage.items} />
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto">
            <JsonView value={result?.state} />
          </div>
        </>
      )}
    </div>
  );
}
